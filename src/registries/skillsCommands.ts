import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { SkillEditorPanel } from '../commands/skillEditorPanel';
import { Skill } from '../skillsManager';

export function registerSkillsCommands(context: vscode.ExtensionContext, services: LollmsServices) {
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addSkill', async (item?: any) => {
        // Determine target scope from the clicked tree item
        let targetScope: 'global' | 'local' = 'global';
        if (item && item.contextValue) {
            if (item.contextValue.includes(':local')) targetScope = 'local';
        } else if (!vscode.workspace.workspaceFolders) {
            targetScope = 'global';
        }

        const panel = SkillEditorPanel.createOrShow(services.extensionUri, services.skillsManager);
        // We inject the target scope into the panel instance so handleSave knows where to write
        (panel as any)._targetScope = targetScope;
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.editSkill', (item: any) => {
        // item can be a Skill object from the tree provider
        const skill = item.skill ? item.skill : item;
        if (skill && skill.id) {
            SkillEditorPanel.createOrShow(services.extensionUri, services.skillsManager, skill);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.learnSelectionAsSkill', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const content = editor.document.getText(editor.selection);
        if (!content) {
            vscode.window.showWarningMessage("Please select some text to learn as a skill.");
            return;
        }

        const skill: Partial<Skill> = {
            name: "New Selection Skill",
            content: content,
            language: editor.document.languageId
        };

        SkillEditorPanel.createOrShow(services.extensionUri, services.skillsManager, skill as Skill);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteSkill', async (item: any) => {
        // Handle input from both direct call and tree context menu
        const skill = item?.skill || item;
        if (!skill || !skill.id) {
            vscode.window.showErrorMessage("Could not identify skill to delete.");
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete skill '${skill.name}'? This will permanently remove the XML file.`,
            { modal: true },
            "Delete"
        );

        if (confirm === "Delete") {
            await services.skillsManager.deleteSkill(skill.id, skill.scope);
            services.treeProviders.skills?.refresh();
            vscode.window.showInformationMessage(`Skill '${skill.name}' deleted.`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteAllSkills', async () => {
        const confirm = await vscode.window.showWarningMessage(
            "Are you sure you want to delete ALL skills (Global and Local)? This cannot be undone.", 
            { modal: true }, 
            "Delete All"
        );
        if (confirm === "Delete All") {
            await services.skillsManager.deleteAllSkills();
            vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
            vscode.window.showInformationMessage("All skills deleted.");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.importSkills', async () => {
        await services.skillsManager.importSkills();
        vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.importSkillFromClaude', async () => {
        const uris = await vscode.window.showOpenDialog({
            title: "Import Claude Code Skill (.md)",
            filters: { "Markdown": ["md"] },
            canSelectMany: true
        });

        if (uris && uris.length > 0) {
            for (const uri of uris) {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const skillData = services.skillsManager.claudeMarkdownToSkill(Buffer.from(bytes).toString('utf8'));
                await services.skillsManager.addSkill(skillData);
            }
            vscode.window.showInformationMessage(`Imported ${uris.length} Claude skill(s).`);
            vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.exportSkills', async (item?: any) => {
        const skillId = item?.skill?.id || item?.id;
        
        const formatChoice = await vscode.window.showQuickPick([
            { label: 'LoLLMs XML (.xml)', value: 'lollms', description: 'Native Lollms format' },
            { label: 'Claude Markdown (.md)', value: 'claude', description: 'Claude Code compatible format' }
        ], { placeHolder: 'Select export format' });

        if (!formatChoice) return;

        await services.skillsManager.exportSkills(
            skillId ? [skillId] : undefined, 
            formatChoice.value as 'lollms' | 'claude'
        );
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refreshSkills', () => {
        services.treeProviders.skills?.refresh();
    }));
}
