import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { CommitInspectorPanel } from '../commands/commitInspectorPanel';

export function registerGitCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {
    
    // Command: Generate Commit Message (from SCM Title or Command Palette)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateCommitMessage', async (arg?: any) => {
        let folder: vscode.WorkspaceFolder | undefined;
        
        // Handle calling from SCM view where arg might be a SourceControl object or ResourceState
        if (arg && arg.rootUri) {
            folder = vscode.workspace.getWorkspaceFolder(arg.rootUri);
        } else if (arg instanceof vscode.Uri) {
            folder = vscode.workspace.getWorkspaceFolder(arg);
        } else {
            folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        }

        if (!folder) {
            vscode.window.showErrorMessage("No workspace folder found to generate commit message for.");
            return;
        }

        try {
            const message = await services.gitIntegration.generateCommitMessage(folder);
            if (message) {
                const gitExtension = vscode.extensions.getExtension('vscode.git');
                if (gitExtension) {
                    const git = gitExtension.exports.getAPI(1);
                    const repo = git.repositories.find((r: any) => r.rootUri.toString() === folder!.uri.toString()) || git.repositories[0];
                    if (repo) {
                        repo.inputBox.value = message;
                    }
                }
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(error.message);
        }
    }));

    // Command: Commit with AI Message (Staged changes)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.commitWithAIMessage', async () => {
        const folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!folder) {
            vscode.window.showErrorMessage("No workspace folder found.");
            return;
        }

        try {
            const message = await services.gitIntegration.generateCommitMessage(folder);
            if (message) {
                const confirm = await vscode.window.showInformationMessage(
                    vscode.l10n.t("prompt.confirmCommit", message),
                    { modal: true },
                    vscode.l10n.t("label.yes")
                );
                
                if (confirm === vscode.l10n.t("label.yes")) {
                    await services.gitIntegration.commitWithMessage(message, folder);
                }
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(error.message);
        }
    }));

    // Command: Internal Commit command (called from Chat Code Blocks)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.gitCommit', async (message: string) => {
        const folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!folder) {
            vscode.window.showErrorMessage("No workspace folder found.");
            return;
        }
        await services.gitIntegration.commitWithMessage(message, folder);
    }));

    // Command: Inspect Commit History
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.inspectCommit', () => {
        CommitInspectorPanel.createOrShow(services.extensionUri, services.gitIntegration, services.lollmsAPI);
    }));
}
