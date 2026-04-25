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

import { LocalizationManager } from './utils/localizationManager';

export async function activate(context: vscode.ExtensionContext) {
    try {
        console.log("[Lollms Debug] Extension Activate Start");
        Logger.initialize(context);
        console.log("[Lollms Debug] Logger Initialized");
        
        await LocalizationManager.initialize(context);
        console.log("[Lollms Debug] LocalizationManager Initialized");
    const testTranslation = LocalizationManager.t("displayName");
    const isLocalized = !testTranslation.includes("%") && testTranslation !== "displayName";
    Logger.info(`Lollms VS Coder is now active! Locale: ${vscode.env.language}. L10n Status: ${isLocalized ? 'Active' : 'Using Keys (Check Cache)'}`);
    
    if (!isLocalized && vscode.env.language !== 'en') {
        Logger.warn("Localization files found but not loaded by VS Code. Manifest strings may appear as %variables%.");
    }

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
        backendType: config.get<any>('backendType') || 'lollms',
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

    // Initialize Project Memory
    const { ProjectMemoryManager } = require('./projectMemoryManager');
    const projectMemoryManager = new ProjectMemoryManager(context);
    const projectMemoryProvider = new (require('./commands/projectMemoryTreeProvider').ProjectMemoryTreeProvider)(projectMemoryManager);
    vscode.window.registerTreeDataProvider('lollmsProjectMemoryView', projectMemoryProvider);

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
        rlmDb,
        projectMemoryManager: projectMemoryManager, // MUST be here for uiCommands
        treeProviders: {}
    };

    // Register Views
    registerViews(context, services);

    // Register Commands
    await registerCommands(context, services, getActiveWorkspace);

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

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.findInGraph', (params: { label: string, type: string }) => {
        CodeExplorerPanel.createOrShow(context.extensionUri, services.codeGraphManager);
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

    if (config.get<boolean>('enableInlineSuggestions')) {
        context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new (require('./commands/inlineSuggestions').LollmsInlineCompletionProvider)(lollmsAPI)));
    }

    // Status Bar
    const statusBar = new LollmsStatusBar(context, lollmsAPI);
    context.subscriptions.push(statusBar);

    // --- CACHE INVALIDATION LISTENERS (GLOBAL FS WATCHER) ---
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    
    const isIgnored = (uri: vscode.Uri) => {
        const p = uri.fsPath;
        return p.includes('.lollms') || p.includes('.git') || p.includes('node_modules') || p.includes('venv');
    };

    watcher.onDidChange(uri => {
        if (isIgnored(uri)) return;
        contextManager.refreshFileInCache(uri);
        contextManager.updateTreeStructure(uri, 'change');
        codeGraphManager.reset();
    });
    
    watcher.onDidCreate(uri => {
        if (isIgnored(uri)) return;
        contextManager.updateTreeStructure(uri, 'create');
        codeGraphManager.reset();
    });
    
    watcher.onDidDelete(uri => {
        if (isIgnored(uri)) return;
        contextManager.refreshFileInCache(uri);
        contextManager.updateTreeStructure(uri, 'delete');
        codeGraphManager.reset();
    });

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
        if (activeWorkspaceFolder?.uri.toString() === folder.uri.toString()) {
            return;
        }

        const isInitialLoad = activeWorkspaceFolder === undefined;
        activeWorkspaceFolder = folder;
        statusBar.updateActiveWorkspace(folder);

        // Notify managers to refresh (Merge logic now handles the multi-root data)
        await discussionManager.initialize();
        await skillsManager.switchWorkspace(vscode.workspace.workspaceFolders?.[0].uri || folder.uri, context.extensionUri);
        await projectMemoryManager.getMemories();
        
        services.treeProviders.skills?.refresh();
        services.treeProviders.discussion?.refresh();
        
        // Code Graph is specifically allowed to focus on the active folder
        codeGraphManager.setWorkspaceRoot(folder.uri);
        codeGraphManager.setContextSetter((key, value) => {
            vscode.commands.executeCommand('setContext', `lollms:${key}`, value);
        });

        if (!isInitialLoad) {
            // If it's the first time we detect a workspace on startup, leave open panels alone.
            ChatPanel.panels.forEach(panel => panel.dispose());
            vscode.window.showInformationMessage(`Lollms workspace switched to '${folder.name}'.`);
        }
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

        const initial = activeWorkspaceFolder 
            ? (folders.find(f => f.uri.toString() === activeWorkspaceFolder!.uri.toString()) || folders[0]) 
            : folders[0];
        switchActiveWorkspace(initial);
    }

    initializeWorkspace();
    
    // Start the Neural Dream Cycle
    projectMemoryManager.performDreamCycle().then(() => {
        Logger.info("Dream Cycle complete: Neural memory reorganized.");
    });

    // --- FIRST RUN & COMPLIANCE WIZARD ---
    const wasConfigured = context.globalState.get<boolean>('lollms.wasConfigured', false);
    const hasCustomKey = config.get<string>('apiKey') !== "";
    const hasCustomModel = config.get<string>('modelName') !== "ollama/mistral";
    const hasCustomUrl = config.get<string>('apiUrl') !== "http://localhost:9642";

    // Bug Fix: Don't show if any manual configuration is detected, unless they haven't signed the CoC
    if (!wasConfigured && !hasCustomKey && !hasCustomModel && !hasCustomUrl) {
        showQuickSetupWizard(context);
    } else if (!wasConfigured) {
        showConductWebview(context);
    }

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

    } catch (e: any) {
        Logger.error("CRITICAL ERROR during extension activation", e);
        vscode.window.showErrorMessage(`Lollms failed to activate: ${e.message}`);
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
                <button class="btn-secondary" onclick="sendMessage('decline')">Maybe Later</button>
                <button class="btn-primary" onclick="sendMessage('agree')">I'm In, Let's Code</button>
            </div>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            function sendMessage(cmd) {
                vscode.postMessage({ command: cmd });
            }
        </script>
    </body>
    </html>`;

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'agree') {
            await context.globalState.update('lollms.wasConfigured', true);
            vscode.window.showInformationMessage("✅ Commitment recorded. Ethical modules activated.");
            panel.dispose();
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
        
    } else if (selection === choices[1].label) {
        await vscode.commands.executeCommand('lollms-vs-coder.showConfigView');
        await context.globalState.update('lollms.wasConfigured', true);
    }
}

export function deactivate(): void {
    disposeTerminal();
}
