import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';

/**
 * Registers the "lollms-vs-coder.selectModel" command.
 *
 * The command fetches the list of available Lollms models from the API,
 * shows a QuickPick UI, and updates the current model when the user selects one.
 * It intelligently updates the configuration target (Global, Workspace, or WorkspaceFolder)
 * based on where the setting is currently defined, ensuring the change takes effect.
 *
 * @param services - The shared Lollms services container.
 */
export function registerSelectModelCommand(context: vscode.ExtensionContext, services: LollmsServices) {
    const disposable = vscode.commands.registerCommand('lollms-vs-coder.selectModel', async () => {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const currentModel = config.get<string>('modelName');

        try {
            // Passing a Promise to showQuickPick makes VS Code show a loading spinner automatically
            const selected = await vscode.window.showQuickPick(
                services.lollmsAPI.getModels(true).then(models => {
                    if (!models || models.length === 0) {
                        return [{ label: "No models found", detail: "Check your API connection settings.", id: null }];
                    }
                    const items = models.map(m => ({
                        label: m.id,
                        description: m.id === currentModel ? '(Current)' : undefined,
                        id: m.id
                    }));
                    items.sort((a, b) => {
                        if (a.id === currentModel) return -1;
                        if (b.id === currentModel) return 1;
                        return a.label.localeCompare(b.label);
                    });
                    return items;
                }),
                {
                    placeHolder: 'Select a Lollms model',
                    matchOnDescription: true,
                    matchOnDetail: true
                }
            );

            if (!selected || (selected as any).id === null) {
                return;
            }

            const selectedId = (selected as any).id;

            // Determine the configuration target to update.
            // If the user has defined the setting in the Workspace or WorkspaceFolder,
            // we must update it there; otherwise, the Global setting would be shadowed.
            const inspect = config.inspect<string>('modelName');
            let target = vscode.ConfigurationTarget.Global;

            if (inspect) {
                if (inspect.workspaceFolderValue !== undefined) {
                    target = vscode.ConfigurationTarget.WorkspaceFolder;
                } else if (inspect.workspaceValue !== undefined) {
                    target = vscode.ConfigurationTarget.Workspace;
                }
            }

            await config.update('modelName', selectedId, target);
            
            vscode.window.showInformationMessage(`Lollms model switched to "${selectedId}"`);

        } catch (err) {
            console.error('Error selecting Lollms model:', err);
            vscode.window.showErrorMessage(`Failed to change Lollms model: ${(err as Error).message}`);
        }
    });

    context.subscriptions.push(disposable);
}
