import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { registerUICommands } from './uiCommands';
import { registerChatCommands } from './chatCommands';
import { registerContextCommands } from '../commands/contextCommands';
import { registerFileCommands } from './fileCommands';
import { registerPromptCommands } from './promptCommands';
import { registerDebugCommands } from './debugCommands';
import { registerWorkflowCommands } from './workflowCommands';
import { registerNotebookCommands } from './notebookCommands';
import { registerTitleAllDiscussions } from '../commands/titleAllDiscussions';
import { registerGitCommands } from './gitCommands';
import { registerPersonalityCommands } from './personalityCommands';
import { registerSkillsCommands } from './skillsCommands';

export async function registerCommands(
    context: vscode.ExtensionContext,
    services: LollmsServices,
    getActiveWorkspace: () => vscode.WorkspaceFolder | undefined
) {
    // CRITICAL: Ensure UI commands (tabs, logs, etc.) are registered first
    registerUICommands(context, services);
    await registerChatCommands(context, services, getActiveWorkspace);
    registerContextCommands(context, services);
    registerFileCommands(context, services, getActiveWorkspace);
    registerPromptCommands(context, services);
    registerDebugCommands(context, services, getActiveWorkspace);
    registerWorkflowCommands(context, services);
    registerNotebookCommands(context, services);
    registerGitCommands(context, services, getActiveWorkspace);
    registerTitleAllDiscussions(context, services.discussionManager);
    registerPersonalityCommands(context, services);
    registerSkillsCommands(context, services);

        context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.resetKnowledge', async () => {
        const { KnowledgeManager } = await import('../knowledgeManager');
        const km = new KnowledgeManager(context);
        await km.resetKnowledge();
        if (ChatPanel.currentPanel) {
            const disc = ChatPanel.currentPanel.getCurrentDiscussion();
            if (disc) {
                let parsed: any = {};
                try { parsed = JSON.parse(disc.discussion_data_zone || '{}'); } catch {}
                Object.keys(parsed).forEach(k => {
                    if (k.startsWith('librarian_findings_') || k.startsWith('findings_')) delete parsed[k];
                });
                disc.discussion_data_zone = JSON.stringify(parsed);
            }
            const rendered = await km.renderContextKnowledge();
            ChatPanel.currentPanel._panel.webview.postMessage({
                command: 'updateKnowledgeContent',
                knowledge: rendered
            });
            ChatPanel.currentPanel.updateContextAndTokens({ isBackgroundSync: false });
        }
        vscode.window.showInformationMessage("🧹 Knowledge Graph (.lollms/knowledge.ttl) has been reset.");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.scrutinizeKnowledgeTree', async () => {
        const panel = ChatPanel.currentPanel;
        if (panel) {
            await panel.handleScrutinizeKnowledgeTree();
        } else {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                vscode.window.showErrorMessage("Workspace required to synchronize Knowledge Graph.");
                return;
            }
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Lollms: Building ABox & Synchronizing Knowledge Graph (${folder.name})...`,
                cancellable: false
            }, async (progress) => {
                if (services.codeGraphManager) {
                    services.codeGraphManager.setWorkspaceRoot(folder.uri);
                    await services.codeGraphManager.buildGraph(undefined, (p) => {
                        progress.report({ message: `${p.status} (${p.percentage}%)` });
                    });
                }
                const { KnowledgeManager } = await import('../knowledgeManager');
                const km = new KnowledgeManager(context);
                if (services.codeGraphManager) {
                    await km.syncCodeGraph(services.codeGraphManager.getGraphData().nodes, services.codeGraphManager.getGraphData().edges, folder);
                }
                vscode.window.showInformationMessage(`✅ Knowledge Graph ABox populated in .lollms/knowledge.ttl!`);
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.openKnowledgeRoot', async () => {
        const { KnowledgeManager } = await import('../knowledgeManager');
        const km = new KnowledgeManager(context);
        const uri = km.getKnowledgeTtlUri();
        if (uri) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to open knowledge.ttl: ${err.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.testAndOptimizeModel', async (targetModel?: string) => {
        const { ModelOptimizerPanel } = await import('../commands/modelOptimizerPanel');
        ModelOptimizerPanel.createOrShow(services.extensionUri, services.lollmsAPI, services, targetModel);
    }));
}