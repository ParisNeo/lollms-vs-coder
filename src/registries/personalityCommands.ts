import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { PersonalityBuilderPanel } from '../commands/personalityBuilderPanel';
import { Personality } from '../personalityManager';
import { PersonalityItem } from '../commands/treeItems';

export function registerPersonalityCommands(context: vscode.ExtensionContext, services: LollmsServices) {
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createPersonality', () => {
        PersonalityBuilderPanel.createOrShow(services.extensionUri, services.personalityManager, services.lollmsAPI);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.editPersonality', (item: Personality | PersonalityItem) => {
        // Handle input from TreeView click (Personality object) or Context Menu (PersonalityItem)
        let personality: Personality;
        
        // Robust check: If 'item' has a property 'personality', it's likely the TreeItem
        if (item && typeof item === 'object' && 'personality' in item) {
            personality = (item as PersonalityItem).personality;
        } else {
            // Otherwise, treat it as the raw Personality object passed from the tree item command arguments
            personality = item as Personality;
        }

        if (personality) {
            PersonalityBuilderPanel.createOrShow(services.extensionUri, services.personalityManager, services.lollmsAPI, personality);
        } else {
            vscode.window.showErrorMessage("Could not determine personality to edit.");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deletePersonality', async (item: PersonalityItem) => {
        if (!item || !item.personality) return;
        
        if (item.personality.isDefault) {
            vscode.window.showWarningMessage("Cannot delete default personalities.");
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete personality '${item.personality.name}'?`,
            { modal: true },
            "Delete"
        );

        if (confirm === "Delete") {
            await services.personalityManager.deletePersonality(item.personality.id);
            // Tree provider refreshes automatically via event listener in manager
        }
    }));
}
