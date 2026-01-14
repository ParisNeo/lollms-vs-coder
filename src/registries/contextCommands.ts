import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { ContextState } from '../commands/contextStateProvider';
import { Logger } from '../logger';
import * as path from 'path';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { AgentManager } from '../agentManager';

export function registerContextCommands(context: vscode.ExtensionContext, services: LollmsServices) {
    
    const setContextState = async (uri: vscode.Uri, uris: vscode.Uri[], state: ContextState) => {
        const targetUris = uris && uris.length > 0 ? uris : (uri ? [uri] : []);
        Logger.info(`Command setContextState triggered for ${targetUris.length} files. State: ${state}`);
        if (targetUris.length > 0) {
            await services.contextManager.getContextStateProvider()?.setStateForUris(targetUris, state);
        } else {
            Logger.warn("setContextState: No URIs provided.");
        }
    };

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextIncluded', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'included')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextTreeOnly', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'tree-only')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextExcluded', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'fully-excluded')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextCollapsed', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'collapsed')));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.setContextDefinitionsOnly', (uri: vscode.Uri, uris: vscode.Uri[]) => setContextState(uri, uris, 'definitions-only')));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addFilesToContext', async (files: string[]) => {
        if (services.contextManager.getContextStateProvider()) {
            await services.contextManager.getContextStateProvider()!.addFilesToContext(files);
        }
    }));

    // Auto Select Context Files Command
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.autoSelectContextFiles', async () => {
        const objective = await vscode.window.showInputBox({
            prompt: vscode.l10n.t("prompt.enterObjectiveForSelection"),
            placeHolder: "e.g., Refactor the authentication logic"
        });

        if (objective) {
             const discussion = services.discussionManager.createNewDiscussion();
             discussion.title = `Auto-Context: ${objective}`;
             await services.discussionManager.saveDiscussion(discussion);
             
             const panel = ChatPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.discussionManager, discussion.id, services.skillsManager);
             
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

            // Run the Auto-Context Tool
            panel.handleManualAutoContext(objective);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.resetContextSelection', async () => {
        await services.contextManager.getContextStateProvider()?.softReset();
        vscode.window.showInformationMessage("Reset included files to default.");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.fullResetContext', async () => {
        const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('prompt.confirmResetContext'), { modal: true }, vscode.l10n.t('label.reset'));
        if (confirm === vscode.l10n.t('label.reset')) {
            await services.contextManager.getContextStateProvider()?.fullReset();
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

        const uri = await vscode.window.showSaveDialog({
            filters: { 'Lollms Context': ['lollms-ctx'] },
            saveLabel: 'Save Context'
        });

        if (uri) {
            try {
                const content = JSON.stringify(included, null, 2);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                vscode.window.showInformationMessage(`Context selection saved to ${path.basename(uri.fsPath)}`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to save context: ${e.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.loadContextSelection', async () => {
        const uris = await vscode.window.showOpenDialog({
            filters: { 'Lollms Context': ['lollms-ctx'] },
            canSelectMany: false,
            openLabel: 'Load Context'
        });

        if (uris && uris[0]) {
            try {
                const content = await vscode.workspace.fs.readFile(uris[0]);
                const files = JSON.parse(Buffer.from(content).toString('utf8'));
                if (Array.isArray(files)) {
                    await vscode.commands.executeCommand('lollms-vs-coder.addFilesToContext', files);
                    vscode.window.showInformationMessage(`Loaded ${files.length} files into context.`);
                } else {
                    vscode.window.showErrorMessage("Invalid context file format.");
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to load context: ${e.message}`);
            }
        }
    }));
}
