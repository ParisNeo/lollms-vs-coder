import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { SettingsPanel } from '../commands/configView';
import { HelpPanel } from '../commands/helpPanel';
import { Logger } from '../logger';
import { registerSelectModelCommand } from '../commands/selectModel';
import { ProcessItem } from '../commands/treeItems';
import { ChatPanel } from '../commands/chatPanel/chatPanel';


export function registerUICommands(context: vscode.ExtensionContext, services: LollmsServices) {

    // Helper to safely register commands and avoid "already exists" crashes
    const safeRegister = (id: string, callback: (...args: any[]) => any) => {
        try {
            context.subscriptions.push(vscode.commands.registerCommand(id, callback));
        } catch (e) {
            Logger.warn(`Command ${id} registration skipped: already exists.`);
        }
    };

    // Note: refreshTools is moved to extension.ts or handled by safeRegister here
    safeRegister('lollms-vs-coder.refreshTools', () => {
        ChatPanel.panels.forEach(p => p.updateGeneratingState());
    });

    safeRegister('lollms-vs-coder.showConfigView', () => 
        SettingsPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.processManager, services.personalityManager));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showHelp', () => 
        HelpPanel.createOrShow(services.extensionUri)));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showLog', () => 
        Logger.show()));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.clearLog', () => {
        Logger.clear();
        // Also clear local logs in the active chat panel if it exists
        if (ChatPanel.currentPanel) {
            (ChatPanel.currentPanel as any)._executionLogs = [];
        }
        vscode.window.showInformationMessage("Lollms: Logs cleared.");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.copyAllErrors', async () => {
        const diagnostics = vscode.languages.getDiagnostics();
        let report = "# WORKSPACE PROBLEMS REPORT\n\n";
        let count = 0;

        for (const [uri, diags] of diagnostics) {
            if (diags.length === 0) continue;
            report += `## File: ${vscode.workspace.asRelativePath(uri)}\n`;
            for (const d of diags) {
                const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARNING';
                report += `- [Line ${d.range.start.line + 1}] [${severity}] ${d.message}\n`;
                count++;
            }
            report += "\n";
        }

        if (count === 0) {
            vscode.window.showInformationMessage("No problems found to copy.");
            return;
        }

        await vscode.env.clipboard.writeText(report);
        vscode.window.showInformationMessage(`✅ Copied ${count} problems to clipboard.`);
    }));

    // --- TAB NAVIGATION LOGIC ---
    const setTab = (tabName: string) => {
        vscode.commands.executeCommand('setContext', 'lollms:activeTab', tabName);
        context.globalState.update('lollms.activeTab', tabName);
        // Refresh the header view to update "Active" indicators
        if (services.treeProviders.tabs) {
            services.treeProviders.tabs.refresh();
        }
    };

    safeRegister('lollms-vs-coder.showChatTab', () => setTab('chat'));
    safeRegister('lollms-vs-coder.showLibrarianTab', () => setTab('librarian'));
    safeRegister('lollms-vs-coder.showPersonasTab', () => {
        setTab('personas');
        vscode.commands.executeCommand('lollms-vs-coder.managePersonalities');
    });
    safeRegister('lollms-vs-coder.showSkillsTab', () => {
        setTab('skills');
        vscode.commands.executeCommand('lollms-vs-coder.manageSkills');
    });
    safeRegister('lollms-vs-coder.showGitTab', () => {
        setTab('git');
        vscode.commands.executeCommand('lollms-vs-coder.showGitDashboard');
    });
    safeRegister('lollms-vs-coder.showGraphTab', () => {
        setTab('graph');
        vscode.commands.executeCommand('lollms-vs-coder.showCodeGraphPanel');
    });
    safeRegister('lollms-vs-coder.showLabTab', () => setTab('lab'));
    safeRegister('lollms-vs-coder.showDeveloperTab', () => setTab('developer'));

    safeRegister('lollms-vs-coder.showStudioTab', () => {
        setTab('studio');
        vscode.commands.executeCommand('lollms-vs-coder.openFlowStudio');
    });

    safeRegister('lollms-vs-coder.openCveBuilder', () => {
        const { CvePanel } = require('../commands/cvePanel');
        CvePanel.createOrShow(services.extensionUri, services.lollmsAPI, services.contextManager);
    });
    safeRegister('lollms-vs-coder.showMcpTab', () => {
        setTab('mcp');
        const { McpManagerPanel } = require('../commands/mcpManagerPanel');
        McpManagerPanel.createOrShow(services.extensionUri);
    });
    safeRegister('lollms-vs-coder.showEnvTab', () => {
        setTab('env');
        const { EnvManagerPanel } = require('../commands/envManagerPanel');
        const folder = vscode.workspace.workspaceFolders?.[0].uri;
        if (folder) EnvManagerPanel.createOrShow(services.extensionUri, folder);
    });
    safeRegister('lollms-vs-coder.showMemoryTab', () => {
        setTab('memory');
        vscode.commands.executeCommand('lollms-vs-coder.manageProjectMemory');
    });
    safeRegister('lollms-vs-coder.showFixTab', () => {
        setTab('fix');
        vscode.commands.executeCommand('lollmsProcessesView.focus');
        vscode.commands.executeCommand('lollms-vs-coder.fixAllErrors');
    });

    // Initialize default tab
    const savedTab = context.globalState.get<'chat' | 'librarian' | 'git' | 'graph' | 'lab'>('lollms.activeTab', 'chat');
    vscode.commands.executeCommand('setContext', 'lollms:activeTab', savedTab);

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showRunningProcesses', () => {
        // Reveal the processes view in the sidebar
        vscode.commands.executeCommand('lollmsProcessesView.focus');
    }));

    // NEW: Cancel Process Command
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.cancelProcess', async (item: ProcessItem) => {
        if (item && item.process) {
            await services.processManager.cancel(item.process.id);
            vscode.window.showInformationMessage(`Cancelled: ${item.process.description}`);
        } else {
            Logger.warn("cancelProcess command called without valid item");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.openStudio', async () => {
        const choice = await vscode.window.showQuickPick([
            { label: '$(lightbulb) Build a Skill', description: 'Create a new reusable skill', command: 'lollms-vs-coder.addSkill' },
            { label: '$(account) Build a Persona', description: 'Create a new AI personality', command: 'lollms-vs-coder.createPersonality' },
            { label: '$(tools) Build a Tool', description: 'Scaffold a new TypeScript tool', command: 'lollms-vs-coder.buildTool' }
        ], { placeHolder: 'Welcome to Lollms Studio. What would you like to build?' });
        if (choice) {
            vscode.commands.executeCommand(choice.command);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.buildTool', async () => {
        const content = `import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const myCustomTool: ToolDefinition = {
    name: "my_custom_tool",
    description: "Describe what this tool does",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "param1", type: "string", description: "A parameter", required: true }
    ],
    async execute(params: { param1: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        // Implement tool logic here
        return { success: true, output: "Tool executed: " + params.param1 };
    }
};
`;
        const doc = await vscode.workspace.openTextDocument({
            language: 'typescript',
            content: content
        });
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage("Tool scaffold created. Save this file in your project or extension tools directory.");
    }));

    // Enhanced Selection Menu (Fallback/Hotkey support)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showSelectionMenu', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) return;

        // Directly open the beautiful modal instead of showing the redundant list
        await vscode.commands.executeCommand('lollms-vs-coder.triggerCodeAction', { isCustom: true });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.manageEnv', () => {
        const { EnvManagerPanel } = require('../commands/envManagerPanel');
        const folder = vscode.workspace.workspaceFolders?.[0].uri;
        if (folder) EnvManagerPanel.createOrShow(services.extensionUri, folder);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.manageProjectMemory', () => {
        const { ProjectMemoryPanel } = require('../commands/projectMemoryPanel');
        ProjectMemoryPanel.createOrShow(services.extensionUri, (services as any).projectMemoryManager);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.manageSkills', () => {
        const { SkillsManagerPanel } = require('../commands/skillsManagerPanel');
        SkillsManagerPanel.createOrShow(services.extensionUri, services.skillsManager);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.managePersonalities', () => {
        const { PersonalityManagerPanel } = require('../commands/personalityManagerPanel');
        PersonalityManagerPanel.createOrShow(services.extensionUri, services.personalityManager);
    }));

    // Support clicking a memory item in the tree to open the manager
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.viewMemory', (item: any) => {
        const { ProjectMemoryPanel } = require('../commands/projectMemoryPanel');
        ProjectMemoryPanel.createOrShow(services.extensionUri, (services as any).projectMemoryManager);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addProjectMemory', async () => {
        const title = await vscode.window.showInputBox({ prompt: "Memory Title", placeHolder: "e.g., Coding Standards" });
        if (!title) return;
        const id = 'mem_' + Date.now();
        await (services as any).projectMemoryManager.updateMemory('add', id, title, "Enter facts for the AI to remember here...");
        vscode.commands.executeCommand('lollms-vs-coder.manageProjectMemory');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteProjectMemory', async (item: any) => {
        const confirm = await vscode.window.showWarningMessage(`Delete memory "${item.memory.title}"?`, { modal: true }, "Delete");
        if (confirm === "Delete") {
            await (services as any).projectMemoryManager.updateMemory('delete', item.memory.id);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.extractProjectDNA', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Extracting Project DNA...",
            cancellable: false
        }, async () => {
            await services.projectMemoryManager.extractProjectDNA(services.contextManager);
            vscode.window.showInformationMessage("✅ Project DNA extracted. I now understand your architectural standards.");
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setMissionBriefing', async () => {
        const panel = ChatPanel.currentPanel;
        if (!panel) {
            vscode.window.showWarningMessage("No active discussion found to set briefing for.");
            return;
        }
        await panel.openMissionBriefingUI();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.peekAgentBrain', async (tier: any) => {
        const panel = ChatPanel.currentPanel;
        const agent = panel?.agentManager;
        if (!agent) {
            vscode.window.showWarningMessage("No active Agent found for this discussion.");
            return;
        }

        let title = "";
        let content = "";

        switch(tier) {
            case 'scratchpad':
                title = "🧠 Agent Thoughts (Scratchpad)";
                const plan = agent['currentPlan'];
                const objective = plan?.objective || "Unknown Mission";
                const remarks = plan?.observations?.join('\n\n') || plan?.scratchpad || "No thoughts recorded yet.";
                content = `# MISSION OBJECTIVE\n${objective}\n\n# CURRENT REASONING\n${remarks}`;
                break;
            case 'memory':
                title = "💾 Agent Working Memory";
                content = `## EPHEMERAL STATE\n` + (agent.sessionState.workingMemory.join('\n\n') || "Empty.");
                content += `\n\n## REPL VARIABLES\n\`\`\`json\n${JSON.stringify(agent.sessionState.replVariables, null, 2)}\n\`\`\``;
                break;
            case 'history':
                title = "📜 Agent Mission Timeline";
                const history = (agent as any).completedActionsHistory ||[];
                content = `# MISSION HISTORY\n\n` + history.map((h: string) => {
                    return h.replace(/^\[(STEP \d+)\]/, '**$1**');
                }).join('\n\n---\n\n');
                if (!history.length) content += `*No actions completed yet.*`;
                break;
            default:
                return;
            }

            const { InfoPanel } = await import('../commands/infoPanel');
            InfoPanel.createOrShow(services.extensionUri, title, content || "No content available.");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.viewFullContext', async (type: 'system' | 'files' | 'chat' | 'tree' | 'images') => {
        const panel = ChatPanel.currentPanel || Array.from(ChatPanel.panels.values())[0];
        if (!panel) {
            vscode.window.showWarningMessage("No active Chat found to display context from.");
            return;
        }

        let title = "";
        let content = "";

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Preparing context view...",
            cancellable: false
        }, async () => {
            try {
                const disc = panel.getCurrentDiscussion();
                const contextData = await services.contextManager.getContextContent({ 
                    importedSkillIds: disc?.importedSkills,
                    modelName: disc?.model || services.lollmsAPI.getModelName()
                });

                if (type === 'system') {
                    title = "Processed System Prompt";
                    const persona = services.personalityManager.getPersonality(disc?.personalityId || 'default_coder');
                    const { getProcessedSystemPrompt } = await import('../utils');
                    content = await getProcessedSystemPrompt(
                        'chat', 
                        (panel as any)._discussionCapabilities, 
                        persona?.systemPrompt,
                        undefined,
                        false,
                        { ...contextData, tree: '', files: '' }
                    );
                } else if (type === 'tree') {
                    title = "Project Tree Structure";
                    content = contextData.projectTree;
                } else if (type === 'files') {
                    title = "Project Context Files";
                    content = `# 🧊 ATTACHED PROJECT CONTEXT\n\n` + contextData.selectedFilesContent;
                } else if (type === 'chat') {
                    title = "Conversation History";
                    content = (disc?.messages || [])
                        .map(m => `### ${m.role.toUpperCase()}\n${m.content}`)
                        .join('\n\n');
                } else if (type === 'images') {
                    title = "Visual Context (Images)";
                    if (contextData.images && contextData.images.length > 0) {
                        content = contextData.images.map(img => 
                            `### ${img.filePath}\n<img src="${img.data}" style="max-width:100%; border-radius:8px; border:1px solid var(--vscode-widget-border);" />`
                        ).join('\n\n---\n\n');
                    } else {
                        content = "*No images currently in context.*";
                    }
                }

                // Send to webview modal
                panel._panel.webview.postMessage({
                    command: 'showContextDetails',
                    title: title,
                    content: content
                });

            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to load context details: ${e.message}`);
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.exportAgentTimeline', async () => {
        const panel = ChatPanel.currentPanel;
        const agent = panel?.agentManager;

        if (agent) {
            await agent.exportTimelineToHtml();
        } else {
            vscode.window.showWarningMessage("No active agent session found to export.");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.copyDiscussionMarkdown', async () => {
        const disc = ChatPanel.currentPanel?.getCurrentDiscussion();
        if (!disc) return;

        let md = `# Discussion: ${disc.title}\n\n`;
        disc.messages.forEach(m => {
            const role = m.role.toUpperCase();
            md += `### ${role}\n${m.content}\n\n---\n\n`;
        });

        await vscode.env.clipboard.writeText(md);
        vscode.window.showInformationMessage("✅ Discussion copied as Markdown.");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.exportDiscussionHtml', async () => {
        const disc = ChatPanel.currentPanel?.getCurrentDiscussion();
        if (!disc) return;

        const html = `<html><body style="font-family: sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; line-height: 1.6;">
            <h1>${disc.title}</h1>
            ${disc.messages.map(m => `<div><strong>${m.role.toUpperCase()}</strong><br><div style="white-space: pre-wrap; margin-bottom: 20px;">${m.content}</div></div>`).join('')}
        </body></html>`;

        const uri = await vscode.window.showSaveDialog({ filters: { 'HTML': ['html'] }, defaultUri: vscode.Uri.file(`discussion_${disc.id}.html`) });
        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(html, 'utf8'));
            vscode.window.showInformationMessage("✅ Discussion exported as HTML.");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.exportAgentAuditMarkdown', async () => {
        const panel = ChatPanel.currentPanel;
        const agent = panel?.agentManager;

        if (!agent) {
            vscode.window.showWarningMessage("No active agent found. Please open the agent discussion first.");
            return;
        }

        const history = (agent as any).completedActionsHistory || [];

        // If history is empty but we have a plan, try to reconstruct from tasks
        if (history.length === 0 && agent['currentPlan']?.tasks.length > 0) {
            const plan = agent['currentPlan'];
            plan.tasks.forEach((t: any) => {
                history.push(`[RECONSTRUCTED STEP ${t.id}]\n- ACTION: ${t.action}\n- INTENT: ${t.description}\n- STATUS: ${t.status}\n- RESULT: ${t.result || 'None'}`);
            });
        }

        if (history.length === 0) {
            vscode.window.showInformationMessage("The audit trail is currently empty. Start a mission first.");
            return;
        }

        const objective = agent['currentPlan']?.objective || "Lollms Mission";

        let md = `# 🤖 Lollms Agentic Audit Trail\n\n`;
        md += `**Objective**: ${objective}\n`;
        md += `**Date**: ${new Date().toLocaleString()}\n\n`;
        md += `--- \n\n`;

        history.forEach((entry: string, i: number) => {
            md += `## Step ${i + 1}\n${entry}\n\n`;
        });

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`mission_audit_${Date.now()}.md`),
            filters: { 'Markdown': ['md'] },
            saveLabel: 'Export Audit Trail'
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf8'));
            vscode.window.showInformationMessage(`✅ Audit trail exported to ${path.basename(uri.fsPath)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.promoteTool', async (item: vscode.TreeItem) => {
        const agent = ChatPanel.currentPanel?.agentManager;
        if (agent && item.label) {
            const session = agent.sessionState as any;
            if (!session.activeToolIds) session.activeToolIds = new Set();
            session.activeToolIds.add(String(item.label));
            services.treeProviders.genieTools?.refresh();
            vscode.window.showInformationMessage(`Genie: '${item.label}' moved to Foreground.`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.demoteTool', async (item: vscode.TreeItem) => {
        const agent = ChatPanel.currentPanel?.agentManager;
        if (agent && item.label) {
            const session = agent.sessionState as any;
            session.activeToolIds?.delete(String(item.label));
            services.treeProviders.genieTools?.refresh();
            vscode.window.showInformationMessage(`Genie: '${item.label}' moved to Background.`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyMemoryTag', async (params: { action: string, id: string, title?: string, content?: string, importance?: number }) => {
        if (services.projectMemoryManager) {
            // If it's a reinforcement (Importance 100 or zap clicked), we use the specific engram refresher
            if (params.importance === 100 || !params.content) {
                await services.projectMemoryManager.reinforceEngram(params.id);
                vscode.window.showInformationMessage(`Lollms: Memory "${params.id}" reinforced. Decay blocked.`);
            } else {
                await services.projectMemoryManager.updateMemory(
                    params.action as any, 
                    params.id, 
                    params.title || params.id, 
                    params.content,
                    "general",
                    params.importance
                );
                vscode.window.showInformationMessage(`Lollms: Fact "${params.id}" synced to Project Memory.`);
            }
        }
    }));

    // Register the missing "selectModel" command
    registerSelectModelCommand(context, services);

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.manageWorkspaces', async () => {
        const { WorkspaceManager } = await import('../utils/workspaceManager');
        const workspaces = await WorkspaceManager.listStoredWorkspaces();

        if (workspaces.length === 0) {
            vscode.window.showInformationMessage("No sovereign workspace data found in ~/.lollms/workspaces");
            return;
        }

        const items = workspaces.map(ws => ({
            label: `$(repo) ${ws.name}`,
            description: ws.id,
            detail: `Path: ${ws.originalPath} | Last used: ${new Date(ws.lastUsed).toLocaleDateString()}`,
            ws: ws
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: "Manage Lollms Workspace Data",
            title: "Stored Intelligence Volumes"
        });

        if (selected) {
            const action = await vscode.window.showQuickPick([
                { label: "$(folder-opened) Open Workspace", id: 'open' },
                { label: "$(cloud-upload) Export Volume (.zip)", id: 'export' },
                { label: "$(trash) Delete Volume (Free Space)", id: 'delete' }
            ]);

            if (action?.id === 'delete') {
                const confirm = await vscode.window.showWarningMessage(
                    `Are you sure you want to delete all AI intelligence (discussions, memory, skills) for "${selected.ws.name}"? This will free disk space but cannot be undone.`,
                    { modal: true }, "Delete Volume"
                );
                if (confirm) {
                    await WorkspaceManager.deleteWorkspace(selected.ws.id);
                    vscode.window.showInformationMessage(`Volume ${selected.ws.id} deleted.`);
                }
            } else if (action?.id === 'export') {
                // Future: Integration with a zip library to export ~/.lollms/workspaces/[id]
                vscode.window.showInformationMessage("Export protocol: Copy the folder ~/.lollms/workspaces/" + selected.ws.id + " to your new device.");
            } else if (action?.id === 'open') {
                const uri = vscode.Uri.file(selected.ws.originalPath);
                vscode.commands.executeCommand('vscode.openFolder', uri);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.triggerSurgicalInsight', async (uri: vscode.Uri, symbol: vscode.SymbolInformation) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const code = doc.getText(symbol.location.range);
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window, // Subtle HUD-style progress
            title: `💎 Lollms Insight: ${symbol.name}...`,
            cancellable: false
        }, async () => {
            const projectDNA = await services.projectMemoryManager.getFormattedMemoryBlock();
            
            const systemPrompt = `You are the Surgical HUD Assistant. 
Analyze the provided code symbol against the Project DNA.
1. Identify 1 Architectural Risk.
2. Identify 1 Potential Bug.
3. Suggest 1 Surgical Improvement.

Keep it extremely brief (max 3 bullets). If you need more space, recommend 'Promote to Discussion'.`;

            const userPrompt = `### PROJECT DNA\n${projectDNA}\n\n### CODE SYMBOL: ${symbol.name}\n\`\`\`\n${code}\n\`\`\``;

            try {
                const response = await services.lollmsAPI.sendChat([
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ]);

                // Show results in a non-intrusive information message with a promotion option
                const choice = await vscode.window.showInformationMessage(
                    `Lollms HUD [${symbol.name}]:\n${response}`,
                    { modal: false },
                    "Promote to Discussion", "Dismiss"
                );

                if (choice === "Promote to Discussion") {
                    const fullPrompt = `### SURGICAL HUD HANDOVER\nI was analyzing the symbol \`${symbol.name}\` in \`${vscode.workspace.asRelativePath(uri)}\`.\n\n**Initial Findings:**\n${response}\n\n**Requirement:** Let's perform a deep-dive refactor on this logic.`;
                    await vscode.commands.executeCommand('lollms-vs-coder.newDiscussionFromClipboard', fullPrompt);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`HUD Analysis failed: ${e.message}`);
            }
        });
    }));
}
