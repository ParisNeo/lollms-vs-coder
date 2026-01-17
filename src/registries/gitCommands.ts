import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { CommitInspectorPanel } from '../commands/commitInspectorPanel';
import { GitManagerPanel } from '../commands/gitManagerPanel'; // Import new panel
import { ChatPanel } from '../commands/chatPanel/chatPanel';

export function registerGitCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {
    
    // Command: Git Manager (New)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.gitManager', () => {
        GitManagerPanel.createOrShow(services.extensionUri, services.gitIntegration, services.lollmsAPI);
    }));

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

    // --- GIT WORKFLOW COMMANDS ---

    // Create a new feature branch and switch to it
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createGitBranch', async (params: { branch: string }) => {
        const folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!folder) {
            vscode.window.showErrorMessage("No workspace folder found for git operations.");
            return;
        }

        // --- NEW: Unstaged Changes Handling ---
        const unstaged = await services.gitIntegration.hasUnstagedChanges(folder);
        if (unstaged) {
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const behavior = config.get<string>('git.unstagedChangesBehavior') || 'stash';
            
            if (behavior === 'error') {
                vscode.window.showErrorMessage("Cannot start AI feature branch: You have unstaged changes. Please commit or stash them first.");
                return;
            }
            if (behavior === 'stash') {
                await services.gitIntegration.stash(folder, `Auto-stash before AI branch: ${params?.branch}`);
                vscode.window.showInformationMessage("Unstaged changes were stashed.");
            }
            // 'keep' behavior does nothing, allowing changes to carry over
        }

        const discussionPanel = ChatPanel.currentPanel;
        if (!discussionPanel || !discussionPanel.getCurrentDiscussion()) {
            vscode.window.showErrorMessage("Active discussion required to track branch state.");
            return;
        }

        const proposedName = params?.branch || `feature-ai-${Date.now()}`;
        const branchName = await vscode.window.showInputBox({
            prompt: "Enter name for new feature branch",
            value: proposedName
        });

        if (!branchName) return;

        try {
            // Save current branch name before switching
            const currentBranch = await services.gitIntegration.getCurrentBranch(folder);
            if (currentBranch) {
                const discussion = discussionPanel.getCurrentDiscussion()!;
                discussion.gitState = {
                    originalBranch: currentBranch,
                    tempBranch: branchName
                };
                await services.discussionManager.saveDiscussion(discussion);
            }

            await services.gitIntegration.createAndCheckoutBranch(folder, branchName);
            vscode.window.showInformationMessage(`Switched to new branch: ${branchName}`);
            
            // Removed chat message injection as requested

        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to create branch: ${e.message}`);
        }
    }));

    // Merge the temp branch back into the original
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.mergeGitBranch', async (params: { branch: string }) => {
        const folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!folder) {
            vscode.window.showErrorMessage("No workspace folder found.");
            return;
        }

        const discussionPanel = ChatPanel.currentPanel;
        if (!discussionPanel || !discussionPanel.getCurrentDiscussion()) {
            vscode.window.showErrorMessage("No active discussion context.");
            return;
        }

        const discussion = discussionPanel.getCurrentDiscussion()!;
        const state = discussion.gitState;

        if (!state || !state.originalBranch || !state.tempBranch) {
            vscode.window.showErrorMessage("No Git Workflow state found in this discussion. Cannot auto-merge.");
            return;
        }

        // Verify we are merging the correct branch
        if (params && params.branch && params.branch !== state.tempBranch) {
             const proceed = await vscode.window.showWarningMessage(
                 `The button says to merge '${params.branch}', but the discussion started with '${state.tempBranch}'. Merge '${state.tempBranch}'?`, 
                 "Yes", "Cancel"
             );
             if (proceed !== "Yes") return;
        }

        try {
            // 1. Checkout original
            await services.gitIntegration.checkout(folder, state.originalBranch);
            
            // 2. Merge temp
            const mergeOutput = await services.gitIntegration.mergeBranch(folder, state.tempBranch);
            
            vscode.window.showInformationMessage(`Successfully merged ${state.tempBranch} into ${state.originalBranch}.`);
            discussionPanel.addMessageToDiscussion({
                role: 'system',
                content: `✅ **Git Workflow:** Merged \`${state.tempBranch}\` into \`${state.originalBranch}\`.\n\nOutput:\n\`\`\`\n${mergeOutput}\n\`\`\``
            });

            // 3. Handle Deletion based on Config
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const autoDelete = config.get<boolean>('git.deleteBranchAfterMerge');

            let shouldDelete = false;

            if (autoDelete) {
                shouldDelete = true;
            } else {
                const deleteChoice = await vscode.window.showInformationMessage(
                    `Delete temporary branch '${state.tempBranch}'?`,
                    "Yes, Delete", "Keep"
                );
                if (deleteChoice === "Yes, Delete") shouldDelete = true;
            }

            if (shouldDelete) {
                await services.gitIntegration.deleteBranch(folder, state.tempBranch);
                discussionPanel.addMessageToDiscussion({
                    role: 'system',
                    content: `🗑️ Deleted branch \`${state.tempBranch}\`.`
                });
            }

            // Clear state
            discussion.gitState = undefined;
            await services.discussionManager.saveDiscussion(discussion);

        } catch (e: any) {
            vscode.window.showErrorMessage(`Merge failed: ${e.message}. You are on ${state.originalBranch}. Please resolve manually.`);
            discussionPanel.addMessageToDiscussion({
                role: 'system',
                content: `❌ **Merge Failed:** ${e.message}\n\nPlease resolve conflicts manually in Source Control view.`
            });
        }
    }));
}
