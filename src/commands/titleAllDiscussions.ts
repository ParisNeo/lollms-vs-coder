import * as vscode from 'vscode';
import { DiscussionManager, Discussion } from '../discussionManager';
import { Logger } from '../logger';

/**
 * Registers the **titleAllDiscussions** command.
 *
 * This implementation scans all stored discussions, finds those that
 * still have an "untitled" (or empty) title, asks the Lollms backend to
 * generate a meaningful title and persists the new title.
 *
 * The operation is **cancellable** – the progress UI now shows a Cancel
 * button. If the user cancels, the command stops processing further
 * discussions but keeps any titles that have already been generated.
 *
 * @param context           VS Code extension context.
 * @param discussionManager Instance that knows how to fetch, save and
 *                          generate titles for discussions.
 */
export function registerTitleAllDiscussions(
    context: vscode.ExtensionContext,
    discussionManager: DiscussionManager
) {
    const disposable = vscode.commands.registerCommand(
        'lollms-vs-coder.titleAllDiscussions',
        async () => {
            try {
                const allDiscussions = await discussionManager.getAllDiscussions();

                // -----------------------------------------------------------------
                // 1️⃣  Find discussions that need a title.
                // -----------------------------------------------------------------
                const untitledDiscussions = allDiscussions.filter((d: Discussion) => {
                    const title = (d.title ?? '').trim().toLowerCase();
                    return title === '' || title.startsWith('untitled') || title.startsWith('new discussion');
                });

                if (untitledDiscussions.length === 0) {
                    vscode.window.showInformationMessage('All discussions already have titles 🎉');
                    Logger.info('titleAllDiscussions – nothing to do');
                    return;
                }

                // -----------------------------------------------------------------
                // 2️⃣  Run the titling process with a **cancellable** progress UI.
                // -----------------------------------------------------------------
                const wasCancelled = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Generating titles for ${untitledDiscussions.length} discussion(s)...`,
                        cancellable: true,                 // <-- make it cancellable
                    },
                    async (progress, token) => {
                        // token: vscode.CancellationToken
                        for (let i = 0; i < untitledDiscussions.length; i++) {
                            const discussion = untitledDiscussions[i];

                            // Respect user cancellation request
                            if (token.isCancellationRequested) {
                                Logger.info('titleAllDiscussions – user cancelled operation');
                                return true; // indicate cancellation
                            }

                            try {
                                const newTitle = await discussionManager.generateDiscussionTitle(discussion);
                                if (newTitle && newTitle.trim() !== '') {
                                    discussion.title = newTitle.trim();
                                    await discussionManager.saveDiscussion(discussion);
                                    Logger.info('titleAllDiscussions – title set', {
                                        discussionId: discussion.id,
                                        newTitle,
                                    });
                                } else {
                                    Logger.warn('titleAllDiscussions – empty title returned', {
                                        discussionId: discussion.id,
                                    });
                                }
                            } catch (innerErr) {
                                Logger.error(
                                    `titleAllDiscussions – error generating title for discussion ${discussion.id}`,
                                    innerErr
                                );
                            }

                            // Update progress bar
                            progress.report({
                                increment: (1 / untitledDiscussions.length) * 100,
                                message: `${i + 1}/${untitledDiscussions.length}`
                            });
                        }

                        return false; // not cancelled
                    }
                );

                // -----------------------------------------------------------------
                // 3️⃣  Refresh the discussion tree view (only if not cancelled).
                // -----------------------------------------------------------------
                if (!wasCancelled) {
                    // Use the correct ID defined in package.json
                    vscode.commands.executeCommand(
                        'workbench.action.refreshTreeView',
                        'lollmsDiscussionsView'
                    ).then(undefined, err => {
                        console.warn("Refresh tree view failed, falling back to provider refresh.");
                        discussionManager.refreshProvider?.(); 
                    });

                    vscode.window.showInformationMessage(
                        `Generated titles for ${untitledDiscussions.length} discussion(s).`
                    );
                    Logger.info('titleAllDiscussions – completed', {
                        processed: untitledDiscussions.length,
                    });
                } else {
                    vscode.window.showInformationMessage('Title generation cancelled by user.');
                }
            } catch (error) {
                Logger.error('Error executing titleAllDiscussions command', error);
                vscode.window.showErrorMessage('Failed to execute titleAllDiscussions command.');
            }
        }
    );

    context.subscriptions.push(disposable);
}
