import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { ContextState } from '../commands/contextStateProvider';
import { Logger } from '../logger';
import * as path from 'path';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { AgentManager } from '../agentManager';

export function registerContextCommands(context: vscode.ExtensionContext, services: LollmsServices) {
    
    const setContextState = async (uri: vscode.Uri | any, uris: vscode.Uri[] | any[], state: ContextState) => {
        // Handle potential Search Result wrappers or plain JSON objects if passed by some views
        let validUri: vscode.Uri | undefined;
        if (uri instanceof vscode.Uri) validUri = uri;
        else if (uri && typeof uri === 'object' && 'scheme' in uri && 'path' in uri) validUri = vscode.Uri.file(uri.path).with({ scheme: uri.scheme });
        
        let validUris: vscode.Uri[] = [];
        if (Array.isArray(uris)) {
            validUris = uris.map(u => {
                if (u instanceof vscode.Uri) return u;
                if (u && typeof u === 'object' && 'scheme' in u && 'path' in u) return vscode.Uri.file(u.path).with({ scheme: u.scheme });
                return undefined;
            }).filter((u): u is vscode.Uri => !!u);
        }

        const targetUris = validUris.length > 0 ? validUris : (validUri ? [validUri] : []);
        
        Logger.info(`Command setContextState triggered for ${targetUris.length} files. State: ${state}`);
        if (targetUris.length > 0) {
            await services.contextManager.getContextStateProvider()?.setStateForUris(targetUris, state);
            
            // Immediately refresh the current chat bubble if open
            if (ChatPanel.currentPanel) {
                ChatPanel.currentPanel.updateContextAndTokens();
            }
        } else {
            Logger.warn("setContextState: No valid URIs provided from command arguments.");
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
            
            // Immediately refresh the current chat bubble if open
            if (ChatPanel.currentPanel) {
                ChatPanel.currentPanel.updateContextAndTokens();
            }
        }
    }));

    // Auto Select Context Files Command
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
             
             const panel = ChatPanel.createOrShow(services.extensionUri, services.lollmsAPI, services.discussionManager, discussion.id, services.gitIntegration, services.skillsManager);
             
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
                    keywords
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
        vscode.window.showInformationMessage("Reset included files to default.");
        
        // Immediately refresh the current chat bubble if open
        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel.updateContextAndTokens();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.fullResetContext', async () => {
        const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('prompt.confirmResetContext'), { modal: true }, vscode.l10n.t('label.reset'));
        if (confirm === vscode.l10n.t('label.reset')) {
            await services.contextManager.getContextStateProvider()?.fullReset();
            vscode.window.showInformationMessage(vscode.l10n.t('info.contextReset'));
            
            // Immediately refresh the current chat bubble if open
            if (ChatPanel.currentPanel) {
                ChatPanel.currentPanel.updateContextAndTokens();
            }
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

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.exportContextContent', async () => {
        try {
            const contextResult = await services.contextManager.getContextContent();
            await vscode.env.clipboard.writeText(contextResult.text);
            vscode.window.showInformationMessage(vscode.l10n.t("info.contextCopied"));
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t("error.failedToExportContext", error.message));
        }
    }));
}
