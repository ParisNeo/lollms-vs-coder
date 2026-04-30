import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { DiscussionItem, DiscussionGroupItem } from '../commands/discussionTreeProvider';
import { startDiscussionWithInitialPrompt } from '../utils/discussionUtils';
import { AgentManager } from '../agentManager';
import { AutomationPanel } from '../panels/automationPanel';
import { getProcessedSystemPrompt, stripThinkingTags } from '../utils';

export async function registerChatCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refreshDiscussions', () => {
        services.treeProviders.discussion?.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.searchDiscussions', async () => {
        const panel = ChatPanel.currentPanel;
        if (panel) {
            panel._panel.webview.postMessage({ command: 'showDiscussionSearchModal' }); 
        } else {
            // Fallback for when no chat is open
            const query = await vscode.window.showInputBox({
                prompt: "Search discussions (Wildcards supported: * and ?)",
                placeHolder: "e.g. auth*, bug?"
            });
            if (query !== undefined) {
                services.treeProviders.discussion?.setFilter(query);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.clearDiscussionSearch', () => {
        services.treeProviders.discussion?.setFilter(undefined);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.startChat', () => {
        if (!getActiveWorkspace()) {
            // No workspace: Start a temporary chat instead of showing error
            vscode.commands.executeCommand('lollms-vs-coder.newTempDiscussion');
            return;
        }
        vscode.commands.executeCommand('lollms-vs-coder.newDiscussion');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newDiscussion', async (item?: DiscussionGroupItem) => {
        const groupId = item instanceof DiscussionGroupItem ? item.group.id : null;
        const discussion = services.discussionManager.createNewDiscussion(groupId);

        // Force standard mode for explicit new discussion
        if (discussion.capabilities) {
            discussion.capabilities.agentMode = false;
        }

        await services.discussionManager.saveDiscussion(discussion);
        const panel = ChatPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.discussionManager, discussion.id, services.gitIntegration, services.skillsManager);
        
        // Use the setAgentManager which handles reconnection logic internally
        const agent = new AgentManager(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager,
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
        
        await panel.loadDiscussion();
        services.treeProviders.discussion?.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newAgentDiscussion', async (item?: DiscussionGroupItem) => {
        const groupId = item instanceof DiscussionGroupItem ? item.group.id : null;
        const discussion = services.discussionManager.createNewDiscussion(groupId);
        
        // --- FORCE AGENT MODE ---
        if (discussion.capabilities) {
            discussion.capabilities.agentMode = true;
        }

        await services.discussionManager.saveDiscussion(discussion);

        const panel = ChatPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.discussionManager, discussion.id, services.gitIntegration, services.skillsManager);

        const agent = new AgentManager(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager,
            services.rlmDb
        );
        agent.projectMemoryManager = services.projectMemoryManager;
        agent.personalityManager = services.personalityManager;
        agent.setProcessManager(services.processManager);

        // Synchronize the manager state silently (without sending a system message yet)
        // This ensures the agent is ready but the chat remains clean for the user's first prompt
        (agent as any).isActive = true; 

        panel.setAgentManager(agent);
        panel.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager);

        await panel.loadDiscussion();
        services.treeProviders.discussion?.refresh();
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newTempDiscussion', async () => {
        const tempId = 'temp-' + Date.now().toString() + Math.random().toString(36).substring(2);
        
        const panel = ChatPanel.createOrShow(
            services.extensionUri, 
            services.lollmsAPI, 
            services.discussionManager, 
            tempId, 
            services.gitIntegration, 
            services.skillsManager
        );
        
        const agent = new AgentManager(
            panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
            services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager
        );
        agent.projectMemoryManager = services.projectMemoryManager;
        agent.personalityManager = services.personalityManager;
        agent.setProcessManager(services.processManager);
        panel.setAgentManager(agent);

        panel.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager); 
        
        await panel.loadDiscussion();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.newDiscussionFromClipboard', async (textOverride?: any) => {
        // Only use textOverride if it is strictly a string. 
        // If triggered from UI menus, VS Code passes a context object which we should ignore.
        const inputContent = (typeof textOverride === 'string') ? textOverride : await vscode.env.clipboard.readText();
        const textToUse = inputContent?.trim();

        if (!textToUse) {
            vscode.window.showWarningMessage('Your clipboard is empty or does not contain text.');
            return;
        }
        
        // autoExecute=false ensures the user can modify the prompt before calling the AI.
        await startDiscussionWithInitialPrompt(services, textToUse, getActiveWorkspace(), false);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteDiscussion', async (item: DiscussionItem) => {
        const deleteButton = { title: vscode.l10n.t('command.delete.title'), id: 'delete' };
        const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('prompt.confirmDelete', item.discussion.title), { modal: true }, deleteButton);
        if (confirm?.id === 'delete') {
            const panel = ChatPanel.panels.get(item.discussion.id);
            panel?.dispose(); 
            // Also cleanup any active agents
            if (ChatPanel.activeAgents.has(item.discussion.id)) {
                ChatPanel.activeAgents.delete(item.discussion.id);
            }
            await services.discussionManager.deleteDiscussion(item.discussion.id);
            services.treeProviders.discussion?.refresh();
        }
    }));

    // Handled in discussion tree provider context menu or generic registry

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateDiscussionTitle', async (item: DiscussionItem) => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('progress.generatingDiscussionTitle'),
            cancellable: false
        }, async () => {
            try {
                const newTitle = await services.discussionManager.generateDiscussionTitle(item.discussion);
                if (newTitle) {
                    item.discussion.title = newTitle;
                    await services.discussionManager.saveDiscussion(item.discussion);
                    
                    const panel = ChatPanel.panels.get(item.discussion.id);
                    if (panel) {
                        panel._panel.title = item.discussion.title;
                    }
                    
                    services.treeProviders.discussion?.refresh();
                } else {
                    vscode.window.showErrorMessage("Failed to generate a title: The AI returned an empty response.");
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Title Generation Error: ${error.message}`);
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.switchDiscussion', async (discussionId: string) => {
        if (!discussionId) return;
        // 1. Create or show panel (sets internal discussionId)
        const panel = ChatPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.discussionManager, discussionId, services.gitIntegration, services.skillsManager);
        panel._panel.reveal();
        
        // 2. Inject dependencies BEFORE loading
        panel.setProcessManager(services.processManager);
        panel.setContextManager(services.contextManager);
        panel.setPersonalityManager(services.personalityManager);
        panel.setHerdManager(services.herdManager); 

        // 3. Connect/Create Agent
        if (ChatPanel.activeAgents.has(discussionId)) {
            const agent = ChatPanel.activeAgents.get(discussionId)!;
            panel.setAgentManager(agent);
        } else {
            const agent = new AgentManager(
                panel, services.lollmsAPI, services.contextManager, services.gitIntegration, 
                services.discussionManager, services.extensionUri, services.codeGraphManager, services.skillsManager,
                services.rlmDb 
            );
            agent.projectMemoryManager = services.projectMemoryManager;
            agent.personalityManager = services.personalityManager;
            agent.setProcessManager(services.processManager);
            panel.setAgentManager(agent);
        }

        // 4. Trigger the load
        await panel.loadDiscussion();
    }));


    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.quickEdit', () => {
        services.quickEditManager.triggerQuickEdit();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.cleanEmptyDiscussions', async () => {
        const yes = vscode.l10n.t('label.yes') || "Yes";
        const prompt = vscode.l10n.t('prompt.confirmCleanEmptyDiscussions') || "Are you sure you want to delete all empty discussions?";
        
        const selection = await vscode.window.showWarningMessage(prompt, { modal: true }, yes);
        
        if (selection === yes) {
            const count = await services.discussionManager.cleanEmptyDiscussions();
            const message = vscode.l10n.t('info.cleanedEmptyDiscussions', count) || `Cleaned ${count} empty discussions.`;
            vscode.window.showInformationMessage(message);
            services.treeProviders.discussion?.refresh();
        }
    }));

    // --- GROUP MANAGEMENT ---

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createDiscussionGroup', async () => {
        const title = await vscode.window.showInputBox({ prompt: "Enter group name", placeHolder: "e.g. Research, Project X, Debugging" });
        if (!title) return;

        const groups = await services.discussionManager.getGroups();
        const newGroup = {
            id: 'group-' + Date.now().toString(),
            title: title,
            description: '',
            timestamp: Date.now()
        };

        groups.push(newGroup);
        await services.discussionManager.saveGroups(groups);
        services.treeProviders.discussion?.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.renameDiscussionGroup', async (item: DiscussionGroupItem) => {
        const newTitle = await vscode.window.showInputBox({ prompt: "Enter new group name", value: item.group.title });
        if (!newTitle) return;

        const groups = await services.discussionManager.getGroups();
        const group = groups.find(g => g.id === item.group.id);
        if (group) {
            group.title = newTitle;
            await services.discussionManager.saveGroups(groups);
            services.treeProviders.discussion?.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteDiscussionGroup', async (item: DiscussionGroupItem) => {
        const confirm = await vscode.window.showWarningMessage(
            `Delete group "${item.group.title}"? Discussions inside will be moved to the root list.`,
            { modal: true }, "Delete"
        );
        if (confirm === "Delete") {
            await services.discussionManager.deleteGroup(item.group.id);
            services.treeProviders.discussion?.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.moveDiscussionToGroup', async (item: DiscussionItem) => {
        const groups = await services.discussionManager.getGroups();
        
        const options = [
            { label: "$(archive) (No Group)", id: null },
            ...groups.map(g => ({ label: `$(folder) ${g.title}`, id: g.id }))
        ];

        const selected = await vscode.window.showQuickPick(options, { placeHolder: "Select destination group" });
        if (selected !== undefined) {
            const discussion = await services.discussionManager.getDiscussion(item.discussion.id);
            if (discussion) {
                discussion.groupId = selected.id;
                await services.discussionManager.saveDiscussion(discussion);
                services.treeProviders.discussion?.refresh();
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.fixAllErrors', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        // --- NEW: FORCE WORKSPACE DIAGNOSTICS ---
        // We attempt to trigger common language server 'check project' commands
        // to populate the Problems tab before scanning.
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Scanning entire workspace for errors...",
            cancellable: false
        }, async (progress) => {
            // Trigger Python analysis if applicable
            await vscode.commands.executeCommand('python.analysis.restart').then(undefined, () => {});
            // Small delay to let the language server start reporting
            await new Promise(r => setTimeout(r, 2000));
        });

        const allDiagnostics = vscode.languages.getDiagnostics();
        const discoveryData: { path: string, uri: vscode.Uri, errors: any[] }[] = [];

        for (const [uri, diagnostics] of allDiagnostics) {
            const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            if (errors.length > 0 && uri.fsPath.startsWith(workspaceFolder.uri.fsPath)) {
                const doc = await vscode.workspace.openTextDocument(uri);
                discoveryData.push({
                    path: vscode.workspace.asRelativePath(uri),
                    uri: uri,
                    errors: errors.map(e => ({
                        line: e.range.start.line + 1,
                        message: e.message,
                        snippet: doc.lineAt(e.range.start.line).text.trim()
                    }))
                });
            }
        }

        if (discoveryData.length === 0) {
            const deepCheck = "Run Deep Scan (CLI)";
            const result = await vscode.window.showInformationMessage(
                "🎉 No active errors found in the Problems tab. Should I run a Deep Scan using terminal tools?",
                deepCheck, "Cancel"
            );

            if (result === deepCheck) {
                // Determine tool based on project type
                const isPython = discoveryData.some(f => f.path.endsWith('.py')) || (await vscode.workspace.findFiles('**/requirements.txt', null, 1)).length > 0;
                const cmd = isPython ? "pip install mypy && mypy ." : "npm run build";

                vscode.window.showInformationMessage(`Starting Deep Scan via: ${cmd}`);
                // Use Agent to run the command and then re-trigger fixAllErrors
                const agent = ChatPanel.currentPanel?.agentManager;
                if (agent) {
                    const res = await agent.runCommand(cmd, new AbortController().signal);
                    // Re-run the fix command now that the terminal has populated diagnostics
                    vscode.commands.executeCommand('lollms-vs-coder.fixAllErrors');
                    return;
                }
            }
            return;
        }

        const autoUI = AutomationPanel.createOrShow(services.extensionUri);
        
        // Provide immediate feedback and send discovery data to unhide the UI
        autoUI.updateOverallProgress(0, "Select errors to repair...");
        autoUI.showDiscovery(discoveryData);

        // Wait for Start signal from UI with specific error line selections
        const selections: Record<string, number[]> = await new Promise((resolve) => {
            const disposable = autoUI['_panel'].webview.onDidReceiveMessage(msg => {
                if (msg.command === 'start') {
                    disposable.dispose();
                    resolve(msg.selections);
                }
            });
        });

        const selectedFiles = Object.keys(selections);
        const { id: processId, controller } = services.processManager.register("global-repair", `Repairing ${selectedFiles.length} files...`);
        autoUI.onDidCancel(() => { services.processManager.cancel(processId); autoUI.dispose(); });

        // Handle Export Request from Webview
        const exportDisposable = autoUI['_panel'].webview.onDidReceiveMessage(async msg => {
            if (msg.command === 'export') {
                const data = msg.data;
                let report = `# 🛠️ Lollms Workspace Repair Report\n`;
                report += `**Started:** ${data.startTime}\n\n`;
                
                report += `## 🔍 Initial Discovery\n`;
                data.discovery.forEach((f: any) => {
                    report += `### File: ${f.path}\n`;
                    f.errors.forEach((e: any) => report += `- [Line ${e.line}] ${e.message}\n`);
                });

                report += `\n## ⏳ Execution Timeline\n`;
                data.timeline.forEach((t: any) => {
                    report += `### [${t.timestamp}] ${t.file}\n`;
                    report += `**Action:** ${t.details} (${t.status.toUpperCase()})\n`;
                    if (t.reasoning) report += `**Reasoning:**\n> ${t.reasoning.replace(/\n/g, '\n> ')}\n\n`;
                });

                report += `\n## 📋 System Logs\n\`\`\`\n`;
                data.systemLogs.forEach((l: any) => report += `[${l.timestamp}] ${l.message}\n`);
                report += `\`\`\`\n`;

                const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
                await vscode.window.showTextDocument(doc);
                vscode.window.showInformationMessage("Repair log exported to a new editor tab.");
            }
        });

        const sharedCache = new Map<string, string>();
        
        try {
            let filesProcessed = 0;
            for (const relPath of selectedFiles) {
                if (controller.signal.aborted) break;
                filesProcessed++;
                const uri = vscode.Uri.joinPath(workspaceFolder.uri, relPath);
                const progress = Math.round((filesProcessed / selectedFiles.length) * 100);
                const selectedLines = selections[relPath] || [];
                const initialDiags = vscode.languages.getDiagnostics(uri).filter(d => 
                    d.severity === vscode.DiagnosticSeverity.Error && selectedLines.includes(d.range.start.line + 1)
                );

                if (initialDiags.length === 0) continue;

                services.processManager.updateDescription(processId, `Repairing ${relPath} (${filesProcessed}/${selectedFiles.length})`);
                autoUI.updateOverallProgress(progress, `Processing ${relPath}...`);
                autoUI.updateFileProgress(relPath, 'scanning', `Scanning file...`, { errorsCount: initialDiags.length });

                let hasFixed = false;
                let retries = 0;
                const max = 3; 
                let extraNudge = "";

                while (retries < max && !hasFixed) {
                    if (controller.signal.aborted) break;
                    retries++;

                    const doc = await vscode.workspace.openTextDocument(uri);
                    // Use initialDiags + extraNudge to prevent polluting the diagnostics objects which lack 'range'
                    const errorLog = initialDiags.map(d => `[Line ${d.range.start.line + 1}] ${d.message}`).join('\n') + extraNudge;
                    const cacheText = Array.from(sharedCache.entries()).map(([p,c]) => `--- ${p} ---\n${c}`).join('\n');

                    const systemPrompt = await getProcessedSystemPrompt('surgical_agent');
                    const userPrompt = `### REPAIR TASK\nFile: ${relPath}\n\nErrors:\n${errorLog}\n\nContent:\n${doc.getText()}\n\nShared Knowledge:\n${cacheText}`;

                    autoUI.updateFileProgress(relPath, 'fixing', `Analyzing errors & dependencies (Attempt ${retries}/${max})...`, {
                        scratchpad: "Preparing prompt and context..."
                    });
                    autoUI.log(`Sending request to LLM for ${relPath}...`);
                    
                    let rawResponse = "";
                    try {
                        rawResponse = await services.lollmsAPI.sendChat([
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt }
                        ], (chunk) => {
                            // Optional: stream small status hints to console
                        }, controller.signal);
                    } catch (apiErr: any) {
                        autoUI.updateFileProgress(relPath, 'error', `API Request failed: ${apiErr.message}`);
                        autoUI.log(`ERROR: LLM communication failed: ${apiErr.message}`);
                        break; 
                    }

                    autoUI.log(`Response received (${rawResponse.length} chars). Processing...`);

                    // 🧠 Robust Reasoning Extraction
                    let scratchpad = "";
                    
                    // 1. Try extracting from common thinking tags (R1, o1, Claude 3.7 style)
                    const thinkMatch = rawResponse.match(/<(?:think|thinking|analysis|reasoning)>([\s\S]*?)<\/\1>/i);
                    if (thinkMatch) {
                        scratchpad = thinkMatch[1].trim();
                    }

                    let cleanResponse = stripThinkingTags(rawResponse);
                    let parsedAction: any = null;

                    // 2. Try extracting from JSON scratchpad (Standard Agent models)
                    try {
                        const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            parsedAction = JSON.parse(jsonMatch[0]);
                            if (parsedAction.scratchpad) {
                                // If we already have <think> content, append the scratchpad to it
                                scratchpad = scratchpad ? `${scratchpad}\n\n---\n${parsedAction.scratchpad}` : parsedAction.scratchpad;
                            }
                        }
                    } catch (e) {}

                    if (!scratchpad) scratchpad = "AI provided a solution directly without a separate reasoning step.";

                    // Update UI with the actual reasoning
                    autoUI.updateFileProgress(relPath, 'fixing', `Analysis complete.`, { 
                        scratchpad 
                    });

                    // 🎯 Tool/Decision Detection
                    if (parsedAction && parsedAction.tool) {
                        try{
                            if (parsedAction.tool === 'read_files') {
                                    const paths = parsedAction.params.paths || [];
                                    autoUI.updateFileProgress(relPath, 'scanning', `Expanding Context...`, { 
                                        scratchpad, decision: `The agent decided it needs to read: ${paths.join(', ')} before fixing.` 
                                    });
                                    autoUI.log(`Tool call: read_files -> ${paths.join(', ')}`);
                                    for(const p of paths) {
                                        autoUI.log(`Peeking at ${p}...`);
                                        const content = await services.contextManager.readSpecificFiles([p]);
                                        sharedCache.set(p, content);
                                    }
                                    autoUI.log(`Context expanded with ${paths.length} files. Retrying fix with new knowledge.`);
                                    continue; 
                            }
                        } catch(e) {}
                    }

                    // 📝 Pre-process response to ensure AIDER markers are at start of lines
                    // Remove markdown fences that wrap the markers
                    // Check for JSON tools first
                    const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        try { parsedAction = JSON.parse(jsonMatch[0]); } catch (e) {}
                    }

                    // Pre-process response to ensure AIDER markers are at start of lines
                    let processedPatch = cleanResponse
                        .replace(/^```\w*\n/gm, '')
                        .replace(/\n```$/gm, '');

                    const aiderCount = (processedPatch.match(/<<<<<<< SEARCH/g) || []).length;

                    // VALIDATION: If neither a tool nor an Aider block is found, the AI just "talked"
                    if (aiderCount === 0 && (!parsedAction || !parsedAction.tool)) {
                        autoUI.log(`❌ ERROR: AI provided dialogue instead of an action. Nudging...`);
                        // Set nudge for next prompt instead of polluting initialDiags array (prevents "reading 'start'" crash)
                        extraNudge = "\nSTRICT INSTRUCTION: You previously provided an explanation. You MUST provide actual AIDER SEARCH/REPLACE blocks now.";
                        continue; 
                    }
                    extraNudge = ""; // Reset if valid output received

                    autoUI.log(`Found ${aiderCount} Aider blocks in response.`);

                    // 📝 Apply Aider Patch
                    autoUI.updateFileProgress(relPath, 'fixing', `Applying ${aiderCount} surgical patches...`, { 
                        scratchpad, patch: processedPatch.substring(0, 1000) + (processedPatch.length > 1000 ? '...' : '') 
                    });

                    await vscode.commands.executeCommand('lollms-vs-coder.replaceCode', relPath, processedPatch, undefined, undefined, { silent: true });

                    // 🔍 Verification
                    await new Promise(r => setTimeout(r, 2500));
                    const currentDiags = vscode.languages.getDiagnostics(uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error);

                    if (currentDiags.length === 0) {
                        autoUI.updateFileProgress(relPath, 'success', `File is now clean! All errors fixed.`, { scratchpad: "Verification passed: 0 errors remaining." });
                        hasFixed = true;
                    } else {
                        autoUI.updateFileProgress(relPath, 'error', `Still contains ${currentDiags.length} errors after attempt.`, { 
                            scratchpad: `The previous patch failed to resolve all issues.\nRemaining Errors:\n${currentDiags.map(d => `[L${d.range.start.line+1}] ${d.message}`).join('\n')}` 
                        });
                    }
                }
            }
            autoUI.updateOverallProgress(100, `Workspace repair finished.`);
        } finally {
            services.processManager.unregister(processId);
            exportDisposable.dispose();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showFileSearch', async () => {
        const { SearchPanel } = await import('../commands/searchPanel');
        SearchPanel.createOrShow(services.extensionUri, services.contextManager);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.runScript', async (code: string, language: string) => {
        const panel = ChatPanel.currentPanel;
        const workspaceFolder = getActiveWorkspace();

        if (!panel) {
            vscode.window.showErrorMessage("No active Lollms chat panel found to display execution output.");
            return;
        }

        if (!workspaceFolder) {
            vscode.window.showErrorMessage("No active workspace folder. Please open a folder to execute scripts.");
            return;
        }

        try {
            await services.scriptRunner.runScript(code, language, panel, workspaceFolder);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to run script: ${error.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.runFile', async (filePath: string) => {
        const workspaceFolder = getActiveWorkspace();
        if (!workspaceFolder) return;

        try {
            const uri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const code = doc.getText();
            const language = doc.languageId;
            
            // Re-use runScript command logic
            await vscode.commands.executeCommand('lollms-vs-coder.runScript', code, language);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to run file ${filePath}: ${e.message}`);
        }
    }));
}
