import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { SettingsPanel } from '../commands/configView';
import { HelpPanel } from '../commands/helpPanel';
import { Logger } from '../logger';
import { registerSelectModelCommand } from '../commands/selectModel';
import { ProcessItem } from '../commands/treeItems';
import { ChatPanel } from '../commands/chatPanel/chatPanel';

export function registerUICommands(context: vscode.ExtensionContext, services: LollmsServices) {
    // Satisfy ToolManager lifecycle requirements
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refreshTools', () => {
        ChatPanel.panels.forEach(p => p.updateGeneratingState());
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showConfigView', () => 
        SettingsPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.processManager, services.personalityManager)));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showHelp', () => 
        HelpPanel.createOrShow(services.extensionUri)));
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showLog', () => 
        Logger.show()));

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
    const setTab = (tabName: 'chat' | 'librarian' | 'git' | 'graph' | 'lab' | 'mcp' | 'env') => {
        vscode.commands.executeCommand('setContext', 'lollms:activeTab', tabName);
        context.globalState.update('lollms.activeTab', tabName);
        // Refresh the header view to update "Active" indicators
        services.treeProviders.tabs?.refresh();
    };

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showChatTab', () => setTab('chat')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showLibrarianTab', () => setTab('librarian')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showGitTab', () => {
        setTab('git');
        vscode.commands.executeCommand('lollms-vs-coder.showGitDashboard');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showGraphTab', () => {
        setTab('graph');
        vscode.commands.executeCommand('lollms-vs-coder.showCodeGraphPanel');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showLabTab', () => setTab('lab')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showMcpTab', () => {
        setTab('mcp');
        const { McpManagerPanel } = require('../commands/mcpManagerPanel');
        McpManagerPanel.createOrShow(services.extensionUri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showEnvTab', () => {
        setTab('env');
        const { EnvManagerPanel } = require('../commands/envManagerPanel');
        const folder = vscode.workspace.workspaceFolders?.[0].uri;
        if (folder) EnvManagerPanel.createOrShow(services.extensionUri, folder);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showMemoryTab', () => {
        setTab('memory');
        // Automatically open the full management UI when clicking the navigation tab
        vscode.commands.executeCommand('lollms-vs-coder.manageProjectMemory');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showFixTab', () => {
        setTab('fix');
        // Automatically trigger the error scan when clicking the tab if user wants
        vscode.commands.executeCommand('lollms-vs-coder.fixAllErrors');
    }));

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
        const disc = panel?.getCurrentDiscussion();
        
        if (!disc) {
            vscode.window.showWarningMessage("No active discussion found to set briefing for.");
            return;
        }

        const briefing = await vscode.window.showInputBox({
            prompt: "Set the MISSION BRIEFING (Task-specific constraints).",
            placeHolder: "e.g., Refactor this without using async/await, strictly follow PEP8.",
            value: disc.discussion_data_zone || ""
        });

        if (briefing !== undefined) {
            disc.discussion_data_zone = briefing;
            await services.discussionManager.saveDiscussion(disc);
            
            panel?.updateContextAndTokens();
            vscode.window.showInformationMessage("🎯 Mission Briefing updated.");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.applyMemoryTag', async (params: { action: string, id: string, title: string, content: string, importance?: number }) => {
        if (services.projectMemoryManager) {
            await services.projectMemoryManager.updateMemory(
                params.action as any, 
                params.id, 
                params.title, 
                params.content,
                "general",
                params.importance
            );
            vscode.window.showInformationMessage(`Lollms: Fact "${params.id}" synced to Project Memory.`);
        }
    }));

    // Register the missing "selectModel" command
    registerSelectModelCommand(context, services);

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
