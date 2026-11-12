import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { ContextState } from './contextStateProvider';
import { Logger } from '../logger';
import * as path from 'path';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { AgentManager } from '../agentManager';

export async function getAvailableContextSelections(): Promise<{ name: string; fileName: string; fileCount?: number; description?: string }[]> {
    const folders = vscode.workspace.workspaceFolders || [];
    const selections: { name: string; fileName: string; fileCount?: number; description?: string }[] = [];
    const seenNames = new Set<string>();

    for (const folder of folders) {
        const selectionDir = vscode.Uri.joinPath(folder.uri, '.lollms', 'selection');
        try {
            const entries = await vscode.workspace.fs.readDirectory(selectionDir);
            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.lollms-ctx')) {
                    if (!seenNames.has(name)) {
                        seenNames.add(name);
                        let fileCount: number | undefined = undefined;
                        let desc: string | undefined = undefined;
                        let displayName = name.replace('.lollms-ctx', '');
                        try {
                            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(selectionDir, name));
                            const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
                            if (Array.isArray(parsed)) {
                                fileCount = parsed.length;
                            } else if (parsed && typeof parsed === 'object') {
                                if (Array.isArray(parsed.files)) fileCount = parsed.files.length;
                                if (parsed.name) displayName = parsed.name;
                                if (parsed.description) desc = parsed.description;
                            }
                        } catch {}
                        selections.push({
                            name: displayName,
                            fileName: name,
                            fileCount,
                            description: desc
                        });
                    }
                }
            }
        } catch {}
    }
    return selections;
}

export function registerContextCommands(context: vscode.ExtensionContext, services: LollmsServices) {
    
    const setContextState = async (uri: vscode.Uri | any, uris: vscode.Uri[] | any[], state: ContextState) => {
        let validUri: vscode.Uri | undefined;
        if (uri instanceof vscode.Uri) validUri = uri;
        else if (uri && typeof uri === 'object' && uri.resourceUri instanceof vscode.Uri) validUri = uri.resourceUri;
        else if (uri && typeof uri === 'object' && 'scheme' in uri && 'path' in uri) validUri = vscode.Uri.file(uri.path).with({ scheme: uri.scheme });

        let validUris: vscode.Uri[] = [];
        if (Array.isArray(uris)) {
            validUris = uris.map(u => {
                if (u instanceof vscode.Uri) return u;
                if (u && typeof u === 'object' && u.resourceUri instanceof vscode.Uri) return u.resourceUri;
                if (u && typeof u === 'object' && 'scheme' in u && 'path' in u) return vscode.Uri.file(u.path).with({ scheme: u.scheme });
                return undefined;
            }).filter((u): u is vscode.Uri => !!u);
        }

        const targetUris = validUris.length > 0 ? validUris : (validUri ? [validUri] : []);

        Logger.info(`Command setContextState triggered for ${targetUris.length} items. State: ${state}`);
        if (targetUris.length > 0) {
            const provider = services.contextManager.getContextStateProvider();
            if (provider) {
                let hasDirectory = false;
                for (const u of targetUris) {
                    try {
                        const st = await vscode.workspace.fs.stat(u);
                        if (st.type === vscode.FileType.Directory) {
                            hasDirectory = true;
                            break;
                        }
                    } catch {}
                }

                if (state === 'included' && hasDirectory) {
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: `Lollms: Recursively adding folder contents...`,
                        cancellable: false
                    }, async () => {
                        await provider.setStateForUris(targetUris, state);
                    });
                    services.contextManager.recordRecentlyAddedFiles(targetUris.map(u => vscode.workspace.asRelativePath(u, false)));
                } else {
                    await provider.setStateForUris(targetUris, state);
                    if (state === 'included' || state === 'definitions-only') {
                        services.contextManager.recordRecentlyAddedFiles(targetUris.map(u => vscode.workspace.asRelativePath(u, false)));
                    }
                }

                const relPaths = targetUris.map(u => vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/').trim());

                for (const u of targetUris) {
                    services.contextManager.refreshFileInCache(u);
                }

                if (state === 'fully-excluded' || state === 'collapsed' || state === 'tree-only') {
                    for (const u of targetUris) {
                        const rel = vscode.workspace.asRelativePath(u, false);
                        services.contextManager.removeFilesUnderPath(rel);
                    }
                }

                const openPanels = new Set<ChatPanel>();
                if (ChatPanel.currentPanel && !ChatPanel.currentPanel.isDisposed) {
                    openPanels.add(ChatPanel.currentPanel);
                }
                ChatPanel.panels.forEach(p => {
                    if (!p.isDisposed) openPanels.add(p);
                });

                const allIncluded = provider.getIncludedFiles();

                for (const panel of openPanels) {
                    if (state === 'included' || state === 'definitions-only') {
                        await panel.unmuteFiles(relPaths);
                        await panel.addFilesToDiscussionContext(relPaths, state);
                    } else if (state === 'fully-excluded' || state === 'tree-only') {
                        await panel.removeFilesFromDiscussionContext(relPaths);
                    }

                    const disc = panel.getCurrentDiscussion();
                    if (disc) {
                        (disc as any).includedFiles = JSON.parse(JSON.stringify(allIncluded));
                        if (disc.capabilities) {
                            (disc.capabilities as any).includedFiles = (disc as any).includedFiles;
                        }
                        if (!disc.id.startsWith('temp-')) {
                            await services.discussionManager.saveDiscussion(disc);
                        }
                    }

                    if (state === 'included' || state === 'definitions-only') {
                        panel.recordCurrentPromptFiles(relPaths);
                    }
                    panel.updateContextAndTokens({ isBackgroundSync: false });
                }
            }
        } else {
            Logger.warn("setContextState: No valid URIs provided from command arguments.");
        }
    };

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.toggleContextIncluded', async (uriOrItem?: vscode.Uri | ContextItem, uris?: vscode.Uri[]) => {
        let targetUri: vscode.Uri | undefined;
        if (uriOrItem instanceof vscode.Uri) {
            targetUri = uriOrItem;
        } else if (uriOrItem && typeof uriOrItem === 'object' && uriOrItem.resourceUri instanceof vscode.Uri) {
            targetUri = uriOrItem.resourceUri;
        } else if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
            targetUri = vscode.window.activeTextEditor.document.uri;
        }
        if (!targetUri) return;

        const provider = services.contextManager.getContextStateProvider();
        if (!provider) return;

        const currentState = provider.getStateForUri(targetUri);
        const newState = currentState === 'included' ? 'tree-only' : 'included';
        await setContextState(targetUri, [targetUri], newState);

        const relPath = vscode.workspace.asRelativePath(targetUri, false);
        const statusMsg = newState === 'included' ? `Added "${relPath}" to AI context [C]` : `Removed "${relPath}" from AI context`;
        vscode.window.setStatusBarMessage(statusMsg, 3000);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextIncluded', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'included')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextIncludedActive', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'included')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextTreeOnly', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'tree-only')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextTreeOnlyActive', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'tree-only')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextExcluded', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'fully-excluded')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextExcludedActive', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'fully-excluded')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextCollapsed', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'collapsed')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextCollapsedActive', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'collapsed')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextDefinitionsOnly', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'definitions-only')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextDefinitionsOnlyActive', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'definitions-only')));

    async function collectFilesFromUri(targetUri: vscode.Uri): Promise<string[]> {
        try {
            const stat = await vscode.workspace.fs.stat(targetUri);
            if (stat.type === vscode.FileType.File) {
                const rel = vscode.workspace.asRelativePath(targetUri, false).replace(/\\/g, '/');
                return [rel];
            } else if (stat.type === vscode.FileType.Directory) {
                const { isPathBlockedFromGraph } = require('../codeGraphManager');
                const entries = await vscode.workspace.fs.readDirectory(targetUri);
                const collected: string[] = [];
                for (const [name, type] of entries) {
                    const childUri = vscode.Uri.joinPath(targetUri, name);
                    const rel = vscode.workspace.asRelativePath(childUri, false).replace(/\\/g, '/');
                    if (isPathBlockedFromGraph(rel)) continue;
                    if (type === vscode.FileType.File) {
                        collected.push(rel);
                    } else if (type === vscode.FileType.Directory) {
                        collected.push(...(await collectFilesFromUri(childUri)));
                    }
                }
                return collected;
            }
        } catch {}
        return [];
    }

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.launchDiscussionWithSelectedFiles', async (uriOrPaths?: any, uris?: vscode.Uri[]) => {
        let selectedRelPaths: string[] = [];

        if (Array.isArray(uriOrPaths) && uriOrPaths.every(p => typeof p === 'string')) {
            selectedRelPaths = uriOrPaths.map(p => p.replace(/\\/g, '/').trim());
        } else {
            let targetUris: vscode.Uri[] = [];
            if (Array.isArray(uris) && uris.length > 0) {
                targetUris = uris;
            } else if (uriOrPaths instanceof vscode.Uri) {
                targetUris = [uriOrPaths];
            } else if (uriOrPaths && typeof uriOrPaths === 'object' && uriOrPaths.resourceUri instanceof vscode.Uri) {
                targetUris = [uriOrPaths.resourceUri];
            } else if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
                targetUris = [vscode.window.activeTextEditor.document.uri];
            }

            for (const u of targetUris) {
                const files = await collectFilesFromUri(u);
                selectedRelPaths.push(...files);
            }
        }

        selectedRelPaths = Array.from(new Set(selectedRelPaths.filter(Boolean)));

        if (selectedRelPaths.length === 0) {
            vscode.window.showWarningMessage("Please select at least one file to launch a discussion.");
            return;
        }

        const provider = services.contextManager.getContextStateProvider();
        const rawIncluded = provider ? provider.getIncludedFiles().map(f => f.path.replace(/\\/g, '/').trim()) : [];
        const activeDisc = ChatPanel.currentPanel?.getCurrentDiscussion();
        const discIncluded = activeDisc ? ((activeDisc as any).includedFiles || []).map((f: any) => (typeof f === 'string' ? f : f.path).replace(/\\/g, '/').trim()) : [];
        const discMuted = activeDisc ? (activeDisc.mutedFiles || []).map((m: string) => m.replace(/\\/g, '/').trim()) : [];

        const allKnownContextFiles = Array.from(new Set([...rawIncluded, ...discIncluded, ...discMuted]));

        // Ensure selected files are added to context provider
        if (provider) {
            await provider.addFilesToContext(selectedRelPaths);
        }

        // Mute all other files in context except the selected ones
        const normSelectedSet = new Set(selectedRelPaths.map(p => p.toLowerCase()));
        const isSelected = (p: string) => {
            const clean = p.toLowerCase();
            return normSelectedSet.has(clean) || selectedRelPaths.some(sp => {
                const sClean = sp.toLowerCase();
                return sClean === clean || sClean.endsWith('/' + clean) || clean.endsWith('/' + sClean);
            });
        };

        const filesToMute: string[] = [];
        for (const f of allKnownContextFiles) {
            if (!isSelected(f)) {
                filesToMute.push(f);
            }
        }

        const shortNames = selectedRelPaths.slice(0, 3).map(p => path.posix.basename(p)).join(', ');
        const extraCount = selectedRelPaths.length > 3 ? ` +${selectedRelPaths.length - 3}` : '';
        const title = `Discussion: ${shortNames}${extraCount} (Fast Mode)`;

        const discussion = services.discussionManager.createNewDiscussion(activeDisc?.groupId || null);
        discussion.title = title;
        discussion.mutedFiles = filesToMute;
        discussion.mutedTools = activeDisc ? [...(activeDisc.mutedTools || [])] : [];
        discussion.mutedSkills = activeDisc ? [...(activeDisc.mutedSkills || [])] : [];
        discussion.mutedDiagrams = activeDisc ? [...(activeDisc.mutedDiagrams || [])] : [];
        discussion.importedSkills = activeDisc ? [...(activeDisc.importedSkills || [])] : [];
        discussion.importedTools = activeDisc ? [...(activeDisc.importedTools || [])] : [];
        discussion.activeDiagrams = activeDisc ? [...(activeDisc.activeDiagrams || [])] : [];
        discussion.model = activeDisc?.model;
        discussion.personalityId = activeDisc?.personalityId || 'default_coder';

        if (activeDisc?.capabilities) {
            discussion.capabilities = JSON.parse(JSON.stringify(activeDisc.capabilities));
        }
        if (!discussion.capabilities) {
            discussion.capabilities = services.discussionManager.getLastCapabilities();
        }

        // Automatically configure Fast Mode and apply muting
        discussion.capabilities.fastMode = true;
        discussion.capabilities.mutedFiles = filesToMute;

        await services.discussionManager.saveDiscussion(discussion);

        const panel = ChatPanel.createOrShow(services, discussion.id);
        panel._panel.reveal();

        const agent = new AgentManager(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration,
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager,
            services.toolManager,
            services.rlmDb
        );
        agent.projectMemoryManager = services.projectMemoryManager;
        agent.personalityManager = services.personalityManager;
        agent.setProcessManager(services.processManager);
        panel.setAgentManager(agent);

        panel.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager);

        await panel.unmuteFiles(selectedRelPaths);
        await panel.muteFiles(filesToMute);
        panel.recordCurrentPromptFiles(selectedRelPaths);

        await panel.loadDiscussion();
        services.treeProviders.discussion?.refresh();

        vscode.window.showInformationMessage(`⚡ Launched new Fast Mode discussion with ${selectedRelPaths.length} active file(s) (${filesToMute.length} other files muted).`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addFilesToContext', async (files: string[]) => {
        const provider = services.contextManager.getContextStateProvider();
        if (provider) {
            const openPanels = new Set<ChatPanel>();
            if (ChatPanel.currentPanel && !ChatPanel.currentPanel.isDisposed) openPanels.add(ChatPanel.currentPanel);
            ChatPanel.panels.forEach(p => { if (!p.isDisposed) openPanels.add(p); });

            for (const panel of openPanels) {
                await panel.unmuteFiles(files);
            }

            const added = await provider.addFilesToContext(files);

            if (added.length > 0) {
                services.contextManager.recordRecentlyAddedFiles(added);
            }

            const allIncluded = provider.getIncludedFiles();

            for (const panel of openPanels) {
                await panel.addFilesToDiscussionContext(added.length > 0 ? added : files, 'included');
                const disc = panel.getCurrentDiscussion();
                if (disc) {
                    (disc as any).includedFiles = JSON.parse(JSON.stringify(allIncluded));
                    if (disc.capabilities) {
                        (disc.capabilities as any).includedFiles = (disc as any).includedFiles;
                    }
                    if (!disc.id.startsWith('temp-')) {
                        await services.discussionManager.saveDiscussion(disc);
                    }
                }
                panel.recordCurrentPromptFiles(added.length > 0 ? added : files);
                panel.updateContextAndTokens({ isBackgroundSync: false });
            }
            return added;
        }
        return [];
    }));

    // Run Tests and Report Command (Single Safe Registration)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.runTestsAndReport', async () => {
        let panel = ChatPanel.currentPanel;
        if (!panel) {
            const discussion = services.discussionManager.createNewDiscussion(null);
            discussion.title = "Test Run & Report";
            await services.discussionManager.saveDiscussion(discussion);
            panel = ChatPanel.createOrShow(services, discussion.id);
            panel.setProcessManager(services.processManager);
            panel.setContextManager(services.contextManager);
            panel.setPersonalityManager(services.personalityManager);
            panel.setHerdManager(services.herdManager);
            await panel.loadDiscussion();
            services.treeProviders.discussion?.refresh();
        }
        panel._panel.reveal();
        await panel.handleRunTestsAndReport();
    }));

    // Start Run / View / Fix Debug Loop Command
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.startDebugLoop', async () => {
        let panel = ChatPanel.currentPanel;
        if (!panel) {
            const discussion = services.discussionManager.createNewDiscussion(null);
            discussion.title = "Debug Loop (Run/View/Fix)";
            await services.discussionManager.saveDiscussion(discussion);
            panel = ChatPanel.createOrShow(services, discussion.id);
            panel.setProcessManager(services.processManager);
            panel.setContextManager(services.contextManager);
            panel.setPersonalityManager(services.personalityManager);
            panel.setHerdManager(services.herdManager);
            await panel.loadDiscussion();
            services.treeProviders.discussion?.refresh();
        }
        panel._panel.reveal();
        await panel.handleRunAndDebugLoop();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.governorFilterFiles', async () => {
        const panel = ChatPanel.currentPanel;
        if (!panel) {
            vscode.window.showWarningMessage("Open a chat discussion to consult the Librarian.");
            return;
        }
        panel._panel.reveal();
        panel._panel.webview.postMessage({ command: 'openGovernorFilterModal' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.autoSelectContextFiles', async () => {
        const userInput = await vscode.window.showInputBox({
            prompt: vscode.l10n.t("prompt.enterObjectiveForSelection"),
            placeHolder: "e.g., Refactor the auth logic # auth, session, jwt"
        });

        if (userInput) {
            let objective = userInput;
            let keywords: string[] = [];

            // Parse optional keywords after a hash
            if (userInput.includes('#')) {
                const parts = userInput.split('#');
                objective = parts[0].trim();
                keywords = parts[1].split(',').map(k => k.trim()).filter(k => k.length > 0);
            }

             const discussion = services.discussionManager.createNewDiscussion();
             discussion.title = `Auto-Context: ${objective}`;
             await services.discussionManager.saveDiscussion(discussion);
             
             const panel = ChatPanel.createOrShow(services, discussion.id);
             
             // Setup Panel Dependencies (same as in newDiscussion)
             panel.agentManager = new AgentManager(
                panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
                services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager
            );
            panel.setProcessManager(services.processManager);
            panel.agentManager.setProcessManager(services.processManager);
            panel.setContextManager(services.contextManager);
            panel.setPersonalityManager(services.personalityManager);
            panel.setHerdManager(services.herdManager);

            await panel.loadDiscussion();
            services.treeProviders.discussion?.refresh();

            // Run the Auto-Context Tool Agent
            const model = discussion.model || services.lollmsAPI.getModelName();
            const { id: processId, controller } = services.processManager.register(discussion.id, 'Running Auto-Context...');
            
            try {
                const contextAgentMsgId = 'ctx_agent_manual_' + Date.now();
                await panel.addMessageToDiscussion({
                    id: contextAgentMsgId,
                    role: 'system',
                    content: `**🧠 Auto-Context Agent**\n*Objective: "${objective}"*\n\n`
                });

                await services.contextManager.runContextAgent(
                    objective, 
                    model, 
                    controller.signal,
                    (newContent) => {
                        panel._panel.webview.postMessage({ 
                            command: 'updateMessage', 
                            messageId: contextAgentMsgId, 
                            newContent: newContent 
                        });
                    },
                    undefined,       // onStatusUpdate
                    keywords,        // initialKeywords
                    'collaborative', // mode
                    discussion,
                    []               // fullHistory
                );
                panel.updateContextAndTokens();
            } finally {
                services.processManager.unregister(processId);
                panel.updateGeneratingState();
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.resetContextSelection', async () => {
        await services.contextManager.getContextStateProvider()?.softReset();
        services.contextManager.clearAllCaches();

        ChatPanel.panels.forEach(panel => {
            const disc = panel.getCurrentDiscussion();
            if (disc) {
                disc.mutedFiles = [];
                disc.importedTools = [];
                disc.activeDiagrams = [];
                disc.lastTokenMetrics = undefined;
                if (!disc.id.startsWith('temp-')) {
                    services.discussionManager.saveDiscussion(disc);
                }
            }
            panel._panel.webview.postMessage({
                command: 'updateContext',
                files: [],
                tools: [],
                diagrams: [],
                mutedFiles: [],
                mutedTools: [],
                mutedDiagrams: []
            });
            panel.updateContextAndTokens({ isBackgroundSync: false });
        });
        vscode.window.showInformationMessage("Reset included files and discussion context.");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.fullResetContext', async () => {
        const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('prompt.confirmResetContext'), { modal: true }, vscode.l10n.t('label.reset'));
        if (confirm === vscode.l10n.t('label.reset')) {
            await services.contextManager.getContextStateProvider()?.fullReset();
            services.contextManager.clearAllCaches();

            ChatPanel.panels.forEach(panel => {
                const disc = panel.getCurrentDiscussion();
                if (disc) {
                    disc.mutedFiles = [];
                    disc.importedTools = [];
                    disc.activeDiagrams = [];
                    disc.lastTokenMetrics = undefined;
                    if (!disc.id.startsWith('temp-')) {
                        services.discussionManager.saveDiscussion(disc);
                    }
                }
                panel._panel.webview.postMessage({
                    command: 'updateContext',
                    files: [],
                    tools: [],
                    diagrams: [],
                    mutedFiles: [],
                    mutedTools: [],
                    mutedDiagrams: []
                });
                panel.updateContextAndTokens({ isBackgroundSync: false });
            });
            vscode.window.showInformationMessage(vscode.l10n.t('info.contextReset'));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.saveContextSelection', async () => {
        const provider = services.contextManager.getContextStateProvider();
        if (!provider) {
            vscode.window.showErrorMessage("Context provider not available.");
            return;
        }
        
        const included = provider.getIncludedFiles().map(f => f.path);
        if (included.length === 0) {
            vscode.window.showInformationMessage("No files currently included in context.");
            return;
        }

        const folders = vscode.workspace.workspaceFolders;
        let defaultUri: vscode.Uri | undefined = undefined;

        if (folders && folders.length > 0) {
            const selectionDir = vscode.Uri.joinPath(folders[0].uri, '.lollms', 'selection');
            try {
                await vscode.workspace.fs.createDirectory(selectionDir);
                defaultUri = vscode.Uri.joinPath(selectionDir, 'context_selection.lollms-ctx');
            } catch (e) {
                Logger.warn("Failed to create .lollms/selection directory", e);
            }
        }

        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'Lollms Context': ['lollms-ctx'] },
            saveLabel: 'Save Context'
        });

        if (uri) {
            try {
                const content = JSON.stringify(included, null, 2);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                vscode.window.showInformationMessage(`Context selection saved to ${path.basename(uri.fsPath)}`);

                // Reactively update the active Chat HUD to refresh the dropdown selection list instantly
                if (ChatPanel.currentPanel) {
                    ChatPanel.currentPanel.updateContextAndTokens({ isBackgroundSync: true });
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to save context: ${e.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.loadContextSelectionDirect', async (fileName: string) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return;

        const targetFileName = fileName.endsWith('.lollms-ctx') ? fileName : `${fileName}.lollms-ctx`;
        let targetUri: vscode.Uri | undefined;

        for (const folder of folders) {
            const candidate = vscode.Uri.joinPath(folder.uri, '.lollms', 'selection', targetFileName);
            try {
                await vscode.workspace.fs.stat(candidate);
                targetUri = candidate;
                break;
            } catch {}
        }

        if (!targetUri) {
            vscode.window.showErrorMessage(`Selection file '${targetFileName}' not found in workspace.`);
            return;
        }

        try {
            const content = await vscode.workspace.fs.readFile(targetUri);
            const parsed = JSON.parse(Buffer.from(content).toString('utf8'));
            const files = Array.isArray(parsed) ? parsed : (parsed?.files || []);
            if (Array.isArray(files)) {
                await services.contextManager.getContextStateProvider()?.softReset();
                await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', files);

                // Auto-toggle to Fast Mode when loading a selection
                const openPanels = new Set<ChatPanel>();
                if (ChatPanel.currentPanel && !ChatPanel.currentPanel.isDisposed) openPanels.add(ChatPanel.currentPanel);
                ChatPanel.panels.forEach(p => { if (!p.isDisposed) openPanels.add(p); });
                for (const panel of openPanels) {
                    await panel.updateCapabilities({ fastMode: true });
                }

                const selName = (parsed && !Array.isArray(parsed) && parsed.name) ? parsed.name : targetFileName.replace('.lollms-ctx', '');
                vscode.window.showInformationMessage(`Context switched to: ${selName} (Fast Mode automatically enabled)`);
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to load context ${targetFileName}: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.loadContextSelection', async () => {
        const folders = vscode.workspace.workspaceFolders;
        let defaultUri: vscode.Uri | undefined = undefined;

        if (folders && folders.length > 0) {
            const selectionDir = vscode.Uri.joinPath(folders[0].uri, '.lollms', 'selection');
            try {
                await vscode.workspace.fs.createDirectory(selectionDir);
                defaultUri = selectionDir;
            } catch (e) {
                Logger.warn("Failed to create .lollms/selection directory", e);
            }
        }

        const uris = await vscode.window.showOpenDialog({
            defaultUri,
            filters: { 'Lollms Context': ['lollms-ctx'] },
            canSelectMany: false,
            openLabel: 'Replace Context'
        });

        if (uris && uris[0]) {
            try {
                const content = await vscode.workspace.fs.readFile(uris[0]);
                const parsed = JSON.parse(Buffer.from(content).toString('utf8'));
                const files = Array.isArray(parsed) ? parsed : (parsed?.files || []);
                if (Array.isArray(files)) {
                    // REPLACE: Soft reset the selection first
                    await services.contextManager.getContextStateProvider()?.softReset();
                    await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', files);

                    // Auto-toggle to Fast Mode when loading a selection
                    const openPanels = new Set<ChatPanel>();
                    if (ChatPanel.currentPanel && !ChatPanel.currentPanel.isDisposed) openPanels.add(ChatPanel.currentPanel);
                    ChatPanel.panels.forEach(p => { if (!p.isDisposed) openPanels.add(p); });
                    for (const panel of openPanels) {
                        await panel.updateCapabilities({ fastMode: true });
                    }

                    vscode.window.showInformationMessage(`Context selection replaced with ${files.length} files (Fast Mode automatically enabled).`);
                } else {
                    vscode.window.showErrorMessage("Invalid context file format.");
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to load context: ${e.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addContextSelection', async () => {
        const folders = vscode.workspace.workspaceFolders;
        let defaultUri: vscode.Uri | undefined = undefined;

        if (folders && folders.length > 0) {
            const selectionDir = vscode.Uri.joinPath(folders[0].uri, '.lollms', 'selection');
            try {
                await vscode.workspace.fs.createDirectory(selectionDir);
                defaultUri = selectionDir;
            } catch (e) {
                Logger.warn("Failed to create .lollms/selection directory", e);
            }
        }

        const uris = await vscode.window.showOpenDialog({
            defaultUri,
            filters: { 'Lollms Context': ['lollms-ctx'] },
            canSelectMany: false,
            openLabel: 'Append Context'
        });

        if (uris && uris[0]) {
            try {
                const content = await vscode.workspace.fs.readFile(uris[0]);
                const parsed = JSON.parse(Buffer.from(content).toString('utf8'));
                const files = Array.isArray(parsed) ? parsed : (parsed?.files || []);
                if (Array.isArray(files)) {
                    // APPEND: Just add files without soft reset
                    await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', files);

                    // Auto-toggle to Fast Mode when loading a selection
                    const openPanels = new Set<ChatPanel>();
                    if (ChatPanel.currentPanel && !ChatPanel.currentPanel.isDisposed) openPanels.add(ChatPanel.currentPanel);
                    ChatPanel.panels.forEach(p => { if (!p.isDisposed) openPanels.add(p); });
                    for (const panel of openPanels) {
                        await panel.updateCapabilities({ fastMode: true });
                    }

                    vscode.window.showInformationMessage(`Appended ${files.length} files to context (Fast Mode automatically enabled).`);
                } else {
                    vscode.window.showErrorMessage("Invalid context file format.");
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to append context: ${e.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.exportContextContent', async () => {
        try {
            const contextResult = await services.contextManager.getContextContent();
            await vscode.env.clipboard.writeText(contextResult.text);
            vscode.window.showInformationMessage(vscode.l10n.t("info.contextCopied"));
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t("error.failedToExportContext", error.message));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.saveCustomContextSelection', async (files: string[]) => {
        if (!files || files.length === 0) {
            vscode.window.showInformationMessage("No files to save.");
            return;
        }

        const folders = vscode.workspace.workspaceFolders;
        let defaultUri: vscode.Uri | undefined = undefined;

        if (folders && folders.length > 0) {
            const selectionDir = vscode.Uri.joinPath(folders[0].uri, '.lollms', 'selection');
            try {
                await vscode.workspace.fs.createDirectory(selectionDir);
                defaultUri = vscode.Uri.joinPath(selectionDir, 'custom_selection.lollms-ctx');
            } catch (e) {
                Logger.warn("Failed to create .lollms/selection directory", e);
            }
        }

        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'Lollms Context': ['lollms-ctx'] },
            saveLabel: 'Save Selection'
        });

        if (uri) {
            try {
                const content = JSON.stringify(files, null, 2);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                vscode.window.showInformationMessage(`Selection saved to ${path.basename(uri.fsPath)}`);

                // Reactively update the active Chat HUD to refresh the dropdown selection list instantly
                if (ChatPanel.currentPanel) {
                    ChatPanel.currentPanel.updateContextAndTokens({ isBackgroundSync: true });
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to save selection: ${e.message}`);
            }
        }
    }));
}
