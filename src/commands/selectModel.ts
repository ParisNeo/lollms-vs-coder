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
                    const items: any[] = [];
                    
                    // Add Manual Entry Option
                    items.push({
                        label: "$(edit) Enter model name manually...",
                        id: "__manual__",
                        alwaysShow: true
                    });

                    if (models && models.length > 0) {
                        const modelItems = models.map(m => ({
                            label: m.id,
                            description: m.id === currentModel ? '(Current)' : undefined,
                            id: m.id
                        }));
                        modelItems.sort((a, b) => {
                            if (a.id === currentModel) return -1;
                            if (b.id === currentModel) return 1;
                            return a.label.localeCompare(b.label);
                        });
                        items.push(...modelItems);
                    }
                    return items;
                }),
                {
                    placeHolder: 'Select a Lollms model',
                    matchOnDescription: true,
                    matchOnDetail: true
                }
            );

            if (!selected) {
                return;
            }

            let selectedId = (selected as any).id;

            if (selectedId === "__manual__") {
                const manualName = await vscode.window.showInputBox({
                    prompt: "Enter the exact model name/id",
                    placeHolder: "e.g. ollama/codellama:7b",
                    value: currentModel
                });
                if (!manualName) return;
                selectedId = manualName.trim();
            }

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
