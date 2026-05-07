import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { CommitInspectorPanel } from '../commands/commitInspectorPanel';
import { GitManagerPanel } from '../commands/gitManagerPanel';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { GitDashboardPanel } from '../commands/gitDashboardPanel';

export function registerGitCommands(context: vscode.ExtensionContext, services: LollmsServices, getActiveWorkspace: () => vscode.WorkspaceFolder | undefined) {
    
    // Command: Git Manager
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.gitManager', () => {
        GitManagerPanel.createOrShow(services.extensionUri, services.gitIntegration, services.lollmsAPI);
    }));

    // Command: Generate Commit Message
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateCommitMessage', async (arg?: any) => {
        let folder: vscode.WorkspaceFolder | undefined;
        
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
            // Activate spinning icon in toolbar
            await vscode.commands.executeCommand('setContext', 'lollms:isGeneratingCommitMessage', true);
            
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
            await vscode.commands.executeCommand('setContext', 'lollms:isGeneratingCommitMessage', false);
        } catch (error: any) {
            await vscode.commands.executeCommand('setContext', 'lollms:isGeneratingCommitMessage', false);
            vscode.window.showErrorMessage(error.message);
        }
    }));

    // Command: Commit with AI Message
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

    // Command: Internal Commit
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.gitCommit', async (message: string) => {
        const folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!folder) {
            vscode.window.showErrorMessage("No workspace folder found.");
            return;
        }
        await services.gitIntegration.commitWithMessage(message, folder);
    }));

    // Command: Inspect Commit History (Supports deep linking)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.inspectCommit', (hash?: string) => {
        CommitInspectorPanel.createOrShow(
            services.extensionUri, 
            services.gitIntegration, 
            services.lollmsAPI, 
            services.discussionManager, 
            hash
        );
    }));

    // Command: Update Submodules
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.gitUpdateSubmodules', async () => {
        const folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!folder) {
            vscode.window.showErrorMessage("No workspace folder found.");
            return;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Updating submodules..." }, async () => {
            try {
                await services.gitIntegration.updateSubmodules(folder);
                vscode.window.showInformationMessage("Submodules updated successfully.");
            } catch (e: any) {
                vscode.window.showErrorMessage(e.message);
            }
        });
    }));

    // Command: Revert Commit
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.gitRevert', async (hash?: string) => {
        const folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!folder) {
            vscode.window.showErrorMessage("No workspace folder found.");
            return;
        }

        let commitHash = hash;
        if (!commitHash) {
            commitHash = await vscode.window.showInputBox({ prompt: "Enter commit hash to revert" });
        }

        if (commitHash) {
            try {
                await services.gitIntegration.revertCommit(folder, commitHash);
                vscode.window.showInformationMessage(`Reverted commit ${commitHash}.`);
            } catch (e: any) {
                vscode.window.showErrorMessage(e.message);
            }
        }
    }));

    // Command: Rebase Branch
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.gitRebase', async () => {
        const folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!folder) return;

        const branches = await services.gitIntegration.getBranches(folder);
        const current = await services.gitIntegration.getCurrentBranch(folder);
        const others = branches.filter(b => b !== current);

        if (others.length === 0) {
            vscode.window.showInformationMessage("No other branches to rebase onto.");
            return;
        }

        const selected = await vscode.window.showQuickPick(others, { placeHolder: `Rebase ${current} onto...` });
        if (selected) {
            try {
                await services.gitIntegration.rebaseBranch(folder, selected);
                vscode.window.showInformationMessage(`Successfully rebased onto ${selected}.`);
            } catch (e: any) {
                vscode.window.showErrorMessage(e.message);
            }
        }
    }));

    // Command: Merge Branch
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.gitMerge', async () => {
        const folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!folder) {
            vscode.window.showErrorMessage("No workspace folder found.");
            return;
        }

        const branches = await services.gitIntegration.getBranches(folder);
        const current = await services.gitIntegration.getCurrentBranch(folder);
        const others = branches.filter(b => b !== current);

        if (others.length === 0) {
            vscode.window.showInformationMessage("No other branches to merge.");
            return;
        }

        const selected = await vscode.window.showQuickPick(others, { placeHolder: `Select branch to merge into ${current}` });
        if (selected) {
            try {
                await services.gitIntegration.mergeBranch(folder, selected);
                vscode.window.showInformationMessage(`Merged ${selected} into ${current}.`);
            } catch (e: any) {
                vscode.window.showErrorMessage(e.message);
            }
        }
    }));

    // --- GIT WORKFLOW COMMANDS ---

    // Create a new feature branch and switch to it
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createGitBranch', async (params: { branch: string }) => {
        const folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!folder) {
            vscode.window.showErrorMessage("No workspace folder found for git operations.");
            return;
        }

        const status = await services.gitIntegration.getGitStatus(folder);
        const isDirty = status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0;

        if (isDirty) {
            const choices = ["📦 Stash and Create", "💾 Commit and Create", "⏩ Carry Over", "Cancel"];
            const result = await vscode.window.showWarningMessage(
                `You have uncommitted changes. How would you like to handle them before creating the new branch?`,
                { modal: true },
                ...choices
            );

            if (result === "Cancel" || !result) return;

            if (result === "📦 Stash and Create") {
                await services.gitIntegration.stash(folder, `Auto-stash before branch: ${params?.branch || 'new-branch'}`);
                vscode.window.showInformationMessage("Uncommitted changes have been stashed.");
            } else if (result === "💾 Commit and Create") {
                const msg = await services.gitIntegration.generateCommitMessage(folder);
                if (!msg) return; // User cancelled inside commit flow
                
                const finalMsg = await vscode.window.showInputBox({
                    prompt: "Confirm AI-generated commit message",
                    value: msg
                });
                
                if (!finalMsg) return;
                await services.gitIntegration.commitWithMessage(finalMsg, folder);
            }
            // "Carry Over" simply proceeds without stashing/committing
        }

        const discussionPanel = ChatPanel.currentPanel;
        if (!discussionPanel || !discussionPanel.getCurrentDiscussion()) {
            vscode.window.showErrorMessage("Active discussion required to track branch state.");
            return;
        }

        const proposedName = params?.branch || `feature-ai-${Date.now()}`;
        const branchNameInput = await vscode.window.showInputBox({
            prompt: "Enter name for new feature branch",
            value: proposedName
        });

        if (!branchNameInput) return;

        // Sanitize: replace spaces with hyphens, remove invalid chars
        const branchName = branchNameInput.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_\-\/\.]/g, '');

        if (!branchName) {
             vscode.window.showErrorMessage("Invalid branch name.");
             return;
        }

        try {
            const currentBranch = await services.gitIntegration.getCurrentBranch(folder);
            
            // Try to create and checkout
            await services.gitIntegration.createAndCheckoutBranch(folder, branchName);
            
            // If successful, track the state
            if (currentBranch) {
                const discussion = discussionPanel.getCurrentDiscussion()!;
                discussion.gitState = { originalBranch: currentBranch, tempBranch: branchName };
                await services.discussionManager.saveDiscussion(discussion);
            }
            
            vscode.window.showInformationMessage(`Switched to new branch: ${branchName}`);
            
            // Explicitly update the UI
            discussionPanel.sendGitBranchState(folder);
            
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to create branch: ${e.message}`);
        }
    }));

    /**
     * Helper to handle Git Checkout conflicts (dirty worktree)
     */
    async function handleCheckoutWithRecovery(folder: vscode.WorkspaceFolder, targetRef: string): Promise<boolean> {
        try {
            await services.gitIntegration.checkout(folder, targetRef);
            return true;
        } catch (e: any) {
            if (e.message.includes("overwritten by checkout") || e.message.includes("local changes")) {
                const choices = ["📦 Stash & Switch", "💾 Commit Changes", "🗑️ Discard All", "Cancel"];
                const result = await vscode.window.showErrorMessage(
                    `Git Conflict: Your local changes would be overwritten by switching to "${targetRef}". What would you like to do?`,
                    { modal: true },
                    ...choices
                );

                if (result === "📦 Stash & Switch") {
                    await services.gitIntegration.stash(folder, `Auto-stash before switching to ${targetRef}`);
                    await services.gitIntegration.checkout(folder, targetRef);
                    vscode.window.showInformationMessage(`Changes stashed and switched to ${targetRef}.`);
                    return true;
                } else if (result === "💾 Commit Changes") {
                    await vscode.commands.executeCommand('lollms-vs-coder.commitWithAIMessage');
                    // We don't auto-switch here because the commit might fail or user might cancel message
                    return false; 
                } else if (result === "🗑️ Discard All") {
                    const confirm = await vscode.window.showWarningMessage("This will PERMANENTLY delete all your uncommitted changes. Are you sure?", { modal: true }, "Yes, Discard");
                    if (confirm === "Yes, Discard") {
                        await services.gitIntegration.discardChanges(folder, "."); // Discard all
                        await services.gitIntegration.checkout(folder, targetRef);
                        return true;
                    }
                }
            } else {
                vscode.window.showErrorMessage(`Checkout failed: ${e.message}`);
            }
            return false;
        }
    }

    // Switch Git Branch (Enhanced with Recovery)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.switchGitBranch', async () => {
        const folder = getActiveWorkspace() || (vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined);
        if (!folder) return;

        const branches = await services.gitIntegration.getBranches(folder);
        const current = await services.gitIntegration.getCurrentBranch(folder);
        
        const items = branches.map(b => ({ 
            label: b, 
            description: b === current ? ' (Active)' : '',
            iconPath: new vscode.ThemeIcon(b.includes('origin/') ? 'cloud' : 'git-branch')
        })).sort((a, b) => a.label === current ? -1 : 1);

        const selected = await vscode.window.showQuickPick(items, { placeHolder: `Switch from ${current} to...` });
        if (selected && selected.label !== current) {
            const success = await handleCheckoutWithRecovery(folder, selected.label);
            if (success && ChatPanel.currentPanel) {
                ChatPanel.currentPanel.sendGitBranchState(folder);
            }
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
        const discussion = discussionPanel?.getCurrentDiscussion();
        const state = discussion?.gitState;

        // If automatic state exists, use it. Otherwise, prompt user.
        let sourceBranch = params?.branch || state?.tempBranch;
        let targetBranch = state?.originalBranch;

        if (!sourceBranch || !targetBranch) {
            // Fallback Mode: Manual selection
            const current = await services.gitIntegration.getCurrentBranch(folder);
            sourceBranch = current;

            // Get possible targets
            const branches = await services.gitIntegration.getBranches(folder);
            const targets = branches.filter(b => b !== current);
            
            if (targets.length === 0) {
                 vscode.window.showErrorMessage("No other branches available to merge into.");
                 return;
            }

            // Heuristic: Prefer 'main' or 'master' or 'develop' if checking out from feature branch
            const preferred = targets.find(b => ['main', 'master', 'develop'].includes(b));
            
            // Allow user to select target
            const selectedTarget = await vscode.window.showQuickPick(targets, { 
                placeHolder: `Merge '${current}' into...`,
            });

            if (!selectedTarget) return; // Cancelled
            targetBranch = selectedTarget;
        } else {
            // Validation if state exists
            if (params && params.branch && params.branch !== state.tempBranch) {
                 const proceed = await vscode.window.showWarningMessage(
                     `The UI request merges '${params.branch}', but discussion state recorded '${state.tempBranch}'. Merge '${state.tempBranch}' instead?`, 
                     "Yes", "Cancel"
                 );
                 if (proceed !== "Yes") return;
            }
        }

        try {
            // 1. Checkout Target
            await services.gitIntegration.checkout(folder, targetBranch);
            
            if (discussionPanel) discussionPanel.sendGitBranchState(folder);
            
            // 2. Merge Source
            const mergeOutput = await services.gitIntegration.mergeBranch(folder, sourceBranch);
            
            vscode.window.showInformationMessage(`Successfully merged ${sourceBranch} into ${targetBranch}.`);
            
            if (discussionPanel) {
                discussionPanel.addMessageToDiscussion({
                    role: 'system',
                    content: `✅ **Git Workflow:** Merged \`${sourceBranch}\` into \`${targetBranch}\`.\n\nOutput:\n\`\`\`\n${mergeOutput}\n\`\`\``
                });
            }

            // 3. Cleanup (Optional)
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const autoDelete = config.get<boolean>('git.deleteBranchAfterMerge');

            let shouldDelete = false;
            // Only suggest deletion if it was a tracked temp branch or user explicitly asks
            if (autoDelete && state?.tempBranch === sourceBranch) {
                shouldDelete = true;
            } else if (state?.tempBranch === sourceBranch) {
                // If it was a tracked session branch, ask user
                const deleteChoice = await vscode.window.showInformationMessage(
                    `Delete temporary branch '${sourceBranch}'?`,
                    "Yes, Delete", "Keep"
                );
                if (deleteChoice === "Yes, Delete") shouldDelete = true;
            }

            if (shouldDelete) {
                await services.gitIntegration.deleteBranch(folder, sourceBranch);
                if (discussionPanel) {
                    discussionPanel.addMessageToDiscussion({
                        role: 'system',
                        content: `🗑️ Deleted branch \`${sourceBranch}\`.`
                    });
                }
            }

            // Clear state if we completed the tracked workflow
            if (discussion && discussion.gitState) {
                discussion.gitState = undefined;
                await services.discussionManager.saveDiscussion(discussion);
            }

        } catch (e: any) {
            vscode.window.showErrorMessage(`Merge failed: ${e.message}. You are now on ${targetBranch}. Please resolve manually.`);
            if (discussionPanel) {
                discussionPanel.addMessageToDiscussion({
                    role: 'system',
                    content: `❌ **Merge Failed:** ${e.message}\n\nManual conflict resolution required.`
                });
            }
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showGitDashboard', () => {
        GitDashboardPanel.createOrShow(services.extensionUri, services.gitIntegration);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.showFileGitHistory', async (uri: vscode.Uri) => {
        const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) return;

        const folder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!folder) return;

        const relPath = vscode.workspace.asRelativePath(fileUri);
        
        // Ensure Dashboard is open
        GitDashboardPanel.createOrShow(services.extensionUri, services.gitIntegration);
        
        // Tell the dashboard to switch to the history view for this file
        setTimeout(() => {
            if (GitDashboardPanel.currentPanel) {
                (GitDashboardPanel.currentPanel as any)._panel.webview.postMessage({
                    command: 'requestFileHistory',
                    path: relPath
                });
            }
        }, 500);
    }));    
}
