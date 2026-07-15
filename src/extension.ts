import * as vscode from 'vscode';
import * as path from 'path';
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
import { ToolManager } from './tools/toolManager';
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

import { LocalizationManager } from './utils/localizationManager';

export async function activate(context: vscode.ExtensionContext): Promise<vscode.ExtensionContext> {
    process.on('unhandledRejection', (reason: any) => {
        if (reason?.message?.includes('connection got disposed')) return;
        Logger.error('Unhandled Rejection:', reason);
    });

    try {
        Logger.initialize(context);
        await LocalizationManager.initialize(context);
        Logger.info(`Lollms VS Coder is now active! Locale: ${vscode.env.language}.`);

    let activeWorkspaceFolder: vscode.WorkspaceFolder | undefined;
    const getActiveWorkspace = () => activeWorkspaceFolder;

    // Python Extension API - Asynchronous Non-Blocking Activation
    const pythonExt = vscode.extensions.getExtension('ms-python.python');
    let pythonExtApi = null;
    if (pythonExt) {
        if (!pythonExt.isActive) {
            pythonExt.activate().then(exports => {
                setPythonApi(exports);
                Logger.info("Python Extension API lazily activated and connected.");
            }).catch(err => {
                Logger.warn("Failed to lazily activate Python Extension:", err);
            });
        } else {
            pythonExtApi = pythonExt.exports;
            setPythonApi(pythonExtApi);
        }
    }

    // Config & API
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const lollmsAPI = new LollmsAPI({
        apiUrl: config.get<string>('apiUrl') || 'http://localhost:9642',
        apiKey: config.get<string>('apiKey')?.trim() || '',
        modelName: config.get<string>('modelName') || 'ollama/mistral',
        ttiModelName: config.get<string>('ttiModelName') || '',
        disableSslVerification: config.get<boolean>('disableSslVerification') || false,
        sslCertPath: config.get<string>('sslCertPath') || '',
        backendType: config.get<any>('backendType') || 'lollms',
        useLollmsExtensions: config.get<boolean>('useLollmsExtensions') ?? true
    }, context.globalState);

    // Initialize Managers
    const { TokenBillingManager } = require('./utils/tokenBillingManager');
    TokenBillingManager.initialize(context);

    const memoryManager = new MemoryManager(context.globalStorageUri);
    const contextManager = new ContextManager(context, lollmsAPI);
    const skillsManager = new SkillsManager(context.globalStorageUri); 
    const scriptRunner = new ScriptRunner(pythonExtApi);
    const promptManager = new PromptManager(context.globalStorageUri);
    const personalityManager = new PersonalityManager(context.globalStorageUri);
    const workflowManager = new WorkflowManager(context.globalStorageUri);
    const gitIntegration = new GitIntegration(lollmsAPI);
    const processManager = new ProcessManager();
    const codeGraphManager = new CodeGraphManager();
    const toolManager = new ToolManager(); // Clean instantiation
    contextManager['toolManager'] = toolManager; // Inject into contextManager for Librarian/Builder use
    const notebookManager = new NotebookManager(lollmsAPI);
    const inlineDiffProvider = new InlineDiffProvider(lollmsAPI);
    const quickEditManager = new QuickEditManager(lollmsAPI, inlineDiffProvider, contextManager, memoryManager);
    const diffManager = new DiffManager();
    const herdManager = new HerdManager(lollmsAPI, contextManager, personalityManager);
    
    // Initialize RLM Database Manager
    const rlmDb = new RLMDatabaseManager(context);
    const rlmProvider = new RLMDatabaseTreeProvider(rlmDb);
    vscode.window.registerTreeDataProvider('lollmsRLMView', rlmProvider);

    // Initialize Project Memory
    const { ProjectMemoryManager } = require('./projectMemoryManager');
    const projectMemoryManager = new ProjectMemoryManager(context, lollmsAPI);
    const projectMemoryProvider = new (require('./commands/projectMemoryTreeProvider').ProjectMemoryTreeProvider)(projectMemoryManager);
    vscode.window.registerTreeDataProvider('lollmsProjectMemoryView', projectMemoryProvider);

    contextManager.setSkillsManager(skillsManager);
    contextManager.setCodeGraphManager(codeGraphManager);
    (contextManager as any).toolManager = toolManager;

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
        toolManager,
        rlmDb,
        projectMemoryManager: projectMemoryManager, // MUST be here for uiCommands
        treeProviders: {}
    };

    // Register Views
    registerViews(context, services);

    // Register Commands (This calls registerUICommands internally)
    await registerCommands(context, services, getActiveWorkspace);

    // Recreate Client command already handled in commandRegistry/uiCommands? No, it's defined here:
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

    // Onboarding Panel Commands
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showOnboardingWizard', (folder: vscode.WorkspaceFolder) => {
        const { OnboardingPanel } = require('./commands/onboardingPanel');
        OnboardingPanel.createOrShow(context.extensionUri, services, folder);
    }));

    // Code Graph Panel Command
    const showCodeGraphPanelCommand = vscode.commands.registerCommand('lollms-vs-coder.showCodeGraphPanel', () => {
        if (services.codeGraphManager) {
            CodeExplorerPanel.createOrShow(context.extensionUri, services.codeGraphManager, services.lollmsAPI);
        } else {
            vscode.window.showErrorMessage('Code Graph Manager not initialized.');
        }
    });
    context.subscriptions.push(showCodeGraphPanelCommand);

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.findInGraph', (params: { label: string, type: string }) => {
        CodeExplorerPanel.createOrShow(context.extensionUri, services.codeGraphManager, services.lollmsAPI);
        CodeExplorerPanel.currentPanel?.focusSymbol(params.label, params.type);
    }));

    // View Knowledge Command (for RLM entries)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.viewKnowledge', (title, content) => {
        InfoPanel.createOrShow(context.extensionUri, `Knowledge: ${title}`, content);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.openAndSelect', async (params: { path: string, text: string }) => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        const uri = vscode.Uri.joinPath(workspaceFolder.uri, params.path);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);

        const content = doc.getText();
        const index = content.indexOf(params.text);

        if (index !== -1) {
            const start = doc.positionAt(index);
            const end = doc.positionAt(index + params.text.length);
            editor.selection = new vscode.Selection(start, end);
            editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
            vscode.window.showInformationMessage("Text found. Replacement code is in your clipboard.");
        }
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

    // HUD Logic moved to Hover Provider in SelectionDecorator
    context.subscriptions.push(new SelectionDecorator(context.extensionUri));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new DebugCodeLensProvider(debugErrorManager)));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ pattern: '**' }, inlineDiffProvider));
    context.subscriptions.push(vscode.languages.registerHoverProvider({ pattern: '**' }, new SelectionHoverProvider()));
    context.subscriptions.push(vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook', new LollmsNotebookCellActionProvider()));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DiffManager.SCHEME, diffManager));

    context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', new LollmsDebugAdapterTrackerFactory()));

    const inlineCompletionProvider = new (require('./commands/inlineSuggestions').LollmsInlineCompletionProvider)(lollmsAPI);

    // Status Bar
    const statusBar = new LollmsStatusBar(context, lollmsAPI);
    context.subscriptions.push(statusBar);

    // --- HIGH-PERFORMANCE ASYNCHRONOUS DEBOUNCE QUEUE ---
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    const isIgnored = (uri: vscode.Uri) => {
        const p = uri.fsPath;
        // Allow .lollms/skills to pass through so we can refresh the library
        if (p.includes(path.join('.lollms', 'skills'))) return false;
        const segments = p.split(/[\\/]/).map(s => s.toLowerCase());
        return segments.some(s => ['.lollms', '.git', 'node_modules', 'venv', '.venv', 'data', 'data_workspace'].includes(s));
    };

    let watcherDebounceTimer: NodeJS.Timeout | undefined;
    const fileEventsQueue = new Map<string, 'change' | 'create' | 'delete'>();

    const flushWatcherQueue = async () => {
        if (fileEventsQueue.size === 0) return;

        const events = Array.from(fileEventsQueue.entries());
        fileEventsQueue.clear();

        Logger.info(`[Sovereign Queue] Flushing ${events.length} pending filesystem events in background.`);

        const caps = services.discussionManager.getLastCapabilities();
        const isSparqlActive = caps.sparqlEnabled !== false ? true : false;

        for (const [fsPath, type] of events) {
            const uri = vscode.Uri.file(fsPath);
            const relPath = vscode.workspace.asRelativePath(uri, false);

            if (type === 'change') {
                contextManager.refreshFileInCache(uri);
                contextManager.updateTreeStructure(uri, 'change');

                // Incremental Sync only: Update the file cache without rebuilding the entire graph structure
                if (isSparqlActive && codeGraphManager.getBuildState() === 'ready') {
                    Logger.info(`[Sovereign Graph] Performing incremental parse for: ${path.basename(fsPath)}`);
                    await codeGraphManager.updateFileInGraph(uri);
                }
            } else if (type === 'create') {
                contextStateProvider.addFileToCache(relPath);
                contextManager.updateTreeStructure(uri, 'create');

                if (isSparqlActive && codeGraphManager.getBuildState() === 'ready') {
                    await codeGraphManager.updateFileInGraph(uri);
                }
            } else if (type === 'delete') {
                contextStateProvider.removeFileFromCache(relPath);
                contextManager.refreshFileInCache(uri);
                contextManager.updateTreeStructure(uri, 'delete');

                if (isSparqlActive && codeGraphManager.getBuildState() === 'ready') {
                    await codeGraphManager.removeFileFromGraph(uri);
                }
            }
        }

        // Trigger single, unified background recount after batch completes
        if (ChatPanel.currentPanel && !ChatPanel.isBatchApplying) {
            ChatPanel.currentPanel.updateContextAndTokens({ isBackgroundSync: true });
        }
    };

    const queueEvent = (uri: vscode.Uri, type: 'change' | 'create' | 'delete') => {
        if (isIgnored(uri)) return;
        if (uri.fsPath.includes('skills')) {
            skillsManager.invalidateCache();
            return;
        }
        fileEventsQueue.set(uri.fsPath, type);

        if (watcherDebounceTimer) clearTimeout(watcherDebounceTimer);
        watcherDebounceTimer = setTimeout(() => {
            flushWatcherQueue();
        }, 1500);
    };

    watcher.onDidChange(uri => queueEvent(uri, 'change'));
    watcher.onDidCreate(uri => queueEvent(uri, 'create'));
    watcher.onDidDelete(uri => queueEvent(uri, 'delete'));

    context.subscriptions.push(watcher);

    // Configuration Listener
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
        if (e.affectsConfiguration('lollmsVsCoder.language')) {
            await LocalizationManager.initialize(context);
            services.treeProviders.actions?.refresh();
            services.treeProviders.discussion?.refresh();
            // Re-render open chat panels
            ChatPanel.panels.forEach(p => p.loadDiscussion());
        }
        if (e.affectsConfiguration('lollmsVsCoder')) {
            const newConfig = vscode.workspace.getConfiguration('lollmsVsCoder');
            lollmsAPI.updateConfig({
                apiUrl: newConfig.get<string>('apiUrl') || 'http://localhost:9642',
                apiKey: newConfig.get<string>('apiKey')?.trim() || '',
                modelName: newConfig.get<string>('modelName') || 'ollama/mistral',
                ttiModelName: newConfig.get<string>('ttiModelName') || '',
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
    const contextStateProvider = new ContextStateProvider(context);
    contextManager.setContextStateProvider(contextStateProvider);
    
    const fileDecorationProvider = new FileDecorationProvider(contextStateProvider);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(fileDecorationProvider));
    vscode.window.registerTreeDataProvider('lollmsFileTreeView', contextStateProvider);

    // Workspace Switching Logic (Now only handles UI updates, not state resets)
    async function switchActiveWorkspace(folder: vscode.WorkspaceFolder) {
        if (!folder || !folder.uri) return;

        if (activeWorkspaceFolder?.uri?.toString() === folder.uri.toString()) {
            return;
        }

        const isInitialLoad = activeWorkspaceFolder === undefined;
        activeWorkspaceFolder = folder;
        // Track the active workspace folder internally
        statusBar.updateActiveWorkspace(folder);

        // Notify managers to refresh (Merge logic now handles the multi-root data)
        await discussionManager.initialize();
        await skillsManager.switchWorkspace(vscode.workspace.workspaceFolders?.[0]?.uri || folder.uri, context.extensionUri);
        await projectMemoryManager.getMemories();

        services.treeProviders.skills?.refresh();
        services.treeProviders.discussion?.refresh();

        // Code Graph is specifically allowed to focus on the active folder
        codeGraphManager.setWorkspaceRoot(folder.uri);
        codeGraphManager.setContextSetter((key, value) => {
            vscode.commands.executeCommand('setContext', `lollms:${key}`, value);
        });

        // Update the Discussion Tree header with the project name
        if (services.treeProviders.discussion && typeof services.treeProviders.discussion.setActiveProject === 'function') {
            services.treeProviders.discussion.setActiveProject(folder.name);
        }

        if (!isInitialLoad) {
            // Preservation: Don't kill active agent panels if they are currently working
            ChatPanel.panels.forEach(panel => {
                if (!panel.agentManager?.getIsActive()) {
                    panel.dispose();
                }
            });
            vscode.window.showInformationMessage(`Lollms workspace switched to '${folder.name}'.`);
        }
    }

    // --- LINEAR ONBOARDING PIPELINE ENGINE ---
    async function runOnboardingPipeline() {
        Logger.info("[Pipeline] Running Onboarding Pipeline validation...");

        // Gate 1: Code of Conduct / Pledge
        const pledgeSigned = context.globalState.get<boolean>('lollms.pledgeSigned', false);
        if (!pledgeSigned) {
            Logger.info("[Pipeline] Gate 1 Blocked: Awaiting Developer Pledge signature.");
            vscode.commands.executeCommand('setContext', 'lollms:isEnvironmentReady', false);
            showConductWebview(context);
            return;
        }

        // Gate 2: Connection Configuration (Server, Key, Model)
        const wasConfigured = context.globalState.get<boolean>('lollms.wasConfigured', false);
        const hasCustomKey = config.get<string>('apiKey') !== "";
        const hasCustomModel = config.get<string>('modelName') !== "ollama/mistral";
        const hasCustomUrl = config.get<string>('apiUrl') !== "http://localhost:9642";

        const isConfigured = wasConfigured || hasCustomKey || hasCustomModel || hasCustomUrl;

        if (!isConfigured) {
            Logger.info("[Pipeline] Gate 2 Blocked: Awaiting active Lollms connection setup.");
            vscode.commands.executeCommand('setContext', 'lollms:isEnvironmentReady', false);
            showQuickSetupWizard(context);
            return;
        }

        // Both Gates Passed: Enable all custom commands, tabs, and sidebar features
        Logger.info("[Pipeline] Gate 1 & 2 Cleared: Environment marked active.");
        vscode.commands.executeCommand('setContext', 'lollms:isEnvironmentReady', true);

        // Gate 3: Project/Workspace Onboarding
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            const activeFolder = activeWorkspaceFolder || folders[0];
            const wasOnboarded = context.workspaceState.get<boolean>('lollms_workspace_onboarded', false);
            if (!wasOnboarded) {
                Logger.info(`[Pipeline] Gate 3: Opening Project Onboarding for '${activeFolder?.name}'`);
                vscode.commands.executeCommand('lollms-vs-coder.showOnboardingWizard', activeFolder);
                return;
            }
        }

        Logger.info("[Pipeline] Onboarding complete. System is fully operational.");
    }

    // Initialization logic
    function initializeWorkspace() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.commands.executeCommand('setContext', 'lollms:hasWorkspace', false);
            return;
        }

        // Critical: Set context and sync graph manager root before anything else
        vscode.commands.executeCommand('setContext', 'lollms:hasWorkspace', true);
        codeGraphManager.setWorkspaceRoot(folders[0].uri);

        // RESTRICTIVE AUTONOMY: We DO NOT build the graph on startup.
        // It remains unbuilt until the user manually triggers a rebuild or executes a query.

        const initial = activeWorkspaceFolder 
            ? (folders.find(f => f && f.uri && f.uri.toString() === activeWorkspaceFolder?.uri?.toString()) || folders[0]) 
            : folders[0];
        if (initial) {
            switchActiveWorkspace(initial);
        }
    }

    // Re-expose pipeline to webview command registries
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.runOnboardingPipeline', async () => {
        await runOnboardingPipeline();
    }));

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

    // DELAYED START: Defer ALL non-critical setups, workspace initializations, and onboarding checks.
    // This guarantees the activate() function resolves in milliseconds, preventing 10-second warning freezes.
    setImmediate(() => {
        Logger.info("Lollms: Extension host registered successfully. Dispatching deferred background initializations...");
        setTimeout(async () => {
            try {
                // Initialize active workspace structure in the background
                initializeWorkspace();

                // Trigger the linear onboarding pipeline in the background
                await runOnboardingPipeline();

                // Start the Neural Dream Cycle asynchronously
                projectMemoryManager.performDreamCycle().then(() => {
                    Logger.info("Dream Cycle complete: Neural memory reorganized.");
                }).catch((err: any) => {
                    Logger.error("Dream Cycle failed", err);
                });

                // Deactivate conflicting extension modules in the background
                if (config.get<boolean>('deactivateConflictingExtensions')) {
                    deactivateConflictingExtensions();
                }
            } catch (err: any) {
                Logger.error("Deferred background initialization failed:", err);
            }
        }, 3000); // 3-second breathing window for the editor UI to finish painting
    });

    return context;

    } catch (e: any) {
        Logger.error("CRITICAL ERROR during extension activation", e);
        vscode.window.showErrorMessage(`Lollms failed to activate: ${e.message}`);
        throw e;
    }
}

async function showConductWebview(context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'lollmsConduct',
        'Lollms: The Developer Pledge',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    const codiconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'out', 'styles', 'codicon.css'));

    panel.webview.html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <link href="${codiconUri}" rel="stylesheet" />
        <style>
            :root {
                --accent: var(--vscode-textLink-foreground);
                --card-bg: var(--vscode-editor-inactiveSelectionBackground);
            }
            body { 
                font-family: var(--vscode-font-family); 
                color: var(--vscode-editor-foreground); 
                background: var(--vscode-editor-background); 
                padding: 40px; 
                line-height: 1.6;
                display: flex;
                justify-content: center;
            }
            .container { max-width: 700px; animation: fadeIn 0.5s ease-out; }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
            
            header { text-align: center; margin-bottom: 40px; }
            h1 { font-size: 2.2em; font-weight: 300; margin-bottom: 10px; }
            .subtitle { opacity: 0.7; font-size: 1.1em; }
            
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 30px 0; }
            .card { 
                background: var(--card-bg); 
                padding: 20px; 
                border-radius: 12px; 
                border: 1px solid var(--vscode-widget-border);
                transition: border-color 0.3s;
            }
            .card:hover { border-color: var(--accent); }
            .card i { font-size: 24px; color: var(--accent); margin-bottom: 10px; display: block; }
            .card h3 { margin: 0 0 10px 0; font-size: 1.1em; }
            .card p { margin: 0; font-size: 0.95em; opacity: 0.85; }

            .eu-notice {
                display: flex; align-items: center; gap: 15px;
                padding: 15px; background: rgba(0, 51, 153, 0.1);
                border-radius: 8px; border: 1px solid rgba(0, 51, 153, 0.3);
                margin-top: 40px; font-size: 0.9em;
            }
            .eu-notice img { width: 30px; }

            .footer { 
                margin-top: 50px; padding-top: 20px;
                border-top: 1px solid var(--vscode-widget-border);
                display: flex; justify-content: space-between; align-items: center;
            }
            
            button { 
                padding: 10px 30px; border-radius: 6px; cursor: pointer; 
                border: none; font-weight: 600; font-size: 1em;
                transition: transform 0.1s, opacity 0.2s;
            }
            button:active { transform: scale(0.98); }
            .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
            .btn-secondary { background: transparent; color: var(--vscode-editor-foreground); opacity: 0.7; }
            button:hover { opacity: 0.9; }
        </style>
    </head>
    <body>
        <div class="container">
            <header>
                <h1>The Lollms Pledge</h1>
                <p class="subtitle">Building the future of software, responsibly.</p>
            </header>

            <p>AI is a powerful teammate, not a replacement for your expertise. By using Lollms, we join a community of developers committed to these core standards:</p>
            
            <div class="grid">
                <div class="card">
                    <i class="codicon codicon-eye"></i>
                    <h3>Transparency</h3>
                    <p>We believe in honesty. Disclose AI assistance when others expect human-only work.</p>
                </div>
                <div class="card">
                    <i class="codicon codicon-shield"></i>
                    <h3>Mastery</h3>
                    <p>You are the pilot. Always review, test, and take ownership of the code you ship.</p>
                </div>
                <div class="card">
                    <i class="codicon codicon-heart"></i>
                    <h3>Ethical Impact</h3>
                    <p>Use this power for good. No manipulative, deceptive, or exploitative systems.</p>
                </div>
                <div class="card">
                    <i class="codicon codicon-lock"></i>
                    <h3>Data Integrity</h3>
                    <p>Respect privacy and IP. Keep sensitive data out of the prompt window.</p>
                </div>
            </div>

            <div class="eu-notice">
                <span class="codicon codicon-info" style="font-size: 20px; color: #ffcc00;"></span>
                <span>This pledge aligns your workflow with the <strong>European AI Act</strong> standards for trustworthy and transparent professional AI use.</span>
            </div>

            <div class="footer">
                <button class="btn-secondary" id="btn-decline">Maybe Later</button>
                <button class="btn-primary" id="btn-agree">I'm In, Let's Code</button>
            </div>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            
            document.getElementById('btn-agree').addEventListener('click', () => {
                vscode.postMessage({ command: 'agree' });
            });
            
            document.getElementById('btn-decline').addEventListener('click', () => {
                vscode.postMessage({ command: 'decline' });
            });
        </script>
    </body>
    </html>`;

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'agree') {
            await context.globalState.update('lollms.pledgeSigned', true);
            vscode.window.showInformationMessage("✅ Commitment recorded. Ethical modules activated.");
            panel.dispose();
            // Automatically advance to Gate 2 (Configuration)
            await vscode.commands.executeCommand('lollms-vs-coder.runOnboardingPipeline');
        } else {
            vscode.window.showWarningMessage("Compliance required: You must accept the Code of Conduct to use Lollms features.");
            panel.dispose();
        }
    });
}

async function showQuickSetupWizard(context: vscode.ExtensionContext) {
    const choices = [
        { label: "🚀 Start Configuration Wizard", description: "Set up your API host and model in 30 seconds." },
        { label: "⚙️ Open Full Settings", description: "Go directly to the advanced configuration panel." },
        { label: "Later", description: "Dismiss for now." }
    ];

    const selection = await vscode.window.showInformationMessage(
        "👋 Welcome to Lollms VS Coder! Let's get your AI connection configured to start coding.",
        ...choices.map(c => c.label)
    );

    if (selection === choices[0].label) {
        // Simple step-by-step wizard
        const backend = await vscode.window.showQuickPick(
            ['lollms', 'ollama', 'openai', 'anthropic', 'google', 'groq'], 
            { title: "Step 1: Select Backend", placeHolder: "Which AI server are you using?" }
        );
        if (!backend) return;

        const url = await vscode.window.showInputBox({
            title: "Step 2: API Host URL",
            value: backend === 'ollama' ? 'http://localhost:11434' : 'http://localhost:9642',
            prompt: "Enter the base URL of your AI server"
        });
        if (!url) return;

        const key = await vscode.window.showInputBox({
            title: "Step 3: API Key (Optional)",
            prompt: "Enter your API key if required by the server",
            password: true
        });

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        await config.update('backendType', backend, vscode.ConfigurationTarget.Global);
        await config.update('apiUrl', url, vscode.ConfigurationTarget.Global);
        if (key) await config.update('apiKey', key, vscode.ConfigurationTarget.Global);

        await context.globalState.update('lollms.wasConfigured', true);

        vscode.window.showInformationMessage("🎉 Lollms configured! Testing connection...");
        await vscode.commands.executeCommand('lollmsApi.recreateClient');
        await vscode.commands.executeCommand('lollms-vs-coder.checkConnection');

        // Automatically advance to Gate 3 (Project Onboarding)
        await vscode.commands.executeCommand('lollms-vs-coder.runOnboardingPipeline');

    } else if (selection === choices[1].label) {
        await vscode.commands.executeCommand('lollms-vs-coder.showConfigView');
        await context.globalState.update('lollms.wasConfigured', true);
    }
}

async function deactivateConflictingExtensions() {
    const conflicting = [
        { id: 'github.copilot', name: 'GitHub Copilot', configKeys: [['github.copilot.enable', { '*': false }]] },
        { id: 'github.copilot-chat', name: 'GitHub Copilot Chat', configKeys: [] },
        { id: 'ms-dotnettools.vscode-dotnet-runtime', name: 'Microsoft Copilot / .NET Runtime', configKeys: [] }
    ];

    for (const ext of conflicting) {
        const extension = vscode.extensions.getExtension(ext.id);
        if (extension) {
            Logger.info(`[Conflict] Detected competing extension: ${ext.name} (${ext.id})`);

            // 1. Mute their features in Settings (if applicable)
            for (const [key, value] of ext.configKeys) {
                try {
                    const targetConfig = vscode.workspace.getConfiguration();
                    await targetConfig.update(key as string, value, vscode.ConfigurationTarget.Global);
                } catch (e) {
                    Logger.warn(`[Conflict] Failed to update config for ${ext.id}: ${e}`);
                }
            }

            // 2. Offer workspace deactivation prompt
            const choice = await vscode.window.showWarningMessage(
                `Lollms has detected that '${ext.name}' is active, which competes with LoLLMs completions. Disable it for this workspace to optimize performance?`,
                "Disable Extension (Workspace)",
                "Ignore"
            );

            if (choice === "Disable Extension (Workspace)") {
                try {
                    await vscode.commands.executeCommand('workbench.extensions.action.disable', ext.id);
                    vscode.window.showInformationMessage(`Successfully disabled '${ext.name}' for this workspace.`);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to disable extension: ${e.message}. You can manually disable it in the Extensions tab.`);
                }
            }
        }
    }
}

export function deactivate(): void {
    Logger.info("Deactivating Lollms VS Coder...");
    // Dispose of the terminal to prevent the UNKNOWN service remoteAgentHostService error on next load
    disposeTerminal();

    // Clear all active panels to ensure clean state
    ChatPanel.panels.forEach(p => p.dispose());
    ChatPanel.panels.clear();
}
