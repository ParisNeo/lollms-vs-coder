import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';

/**
 * Registers the "lollms-vs-coder.selectModel" command.
 *
 * The command fetches the list of available Lollms models from the API,
 * shows a QuickPick UI, and updates the current model when the user selects one.
 *
 * @param services - The shared Lollms services container.
 */
export function registerSelectModelCommand(context: vscode.ExtensionContext, services: LollmsServices) {
    const disposable = vscode.commands.registerCommand('lollms-vs-coder.selectModel', async () => {
        try {
            // Retrieve the list of models from the Lollms API.
            // The API contract is assumed to provide `listModels()` returning an array of { id: string, name?: string }.
            const models = await services.lollmsAPI.getModels?.();

            if (!models || models.length === 0) {
                vscode.window.showWarningMessage('No Lollms models are available.');
                return;
            }

            // Prepare items for QuickPick – show a friendly name if present.
            const items = models.map(m => ({
                label: m.name ?? m.id,
                description: '',
                id: m.id
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a Lollms model',
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (!selected) {
                // User cancelled the picker.
                return;
            }

            // Ask the API to switch the active model.
            await services.lollmsAPI.setCurrentModel?.(selected.id);
            vscode.window.showInformationMessage(`Lollms model switched to "${selected.label}"`);
        } catch (err) {
            console.error('Error selecting Lollms model:', err);
            vscode.window.showErrorMessage('Failed to change Lollms model. See console for details.');
        }
    });

    context.subscriptions.push(disposable);
}
