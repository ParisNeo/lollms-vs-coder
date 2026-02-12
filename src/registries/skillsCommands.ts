import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { SkillEditorPanel } from '../commands/skillEditorPanel';
import { Skill } from '../skillsManager';

export function registerSkillsCommands(context: vscode.ExtensionContext, services: LollmsServices) {
    
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addSkill', () => {
        SkillEditorPanel.createOrShow(services.extensionUri, services.skillsManager);
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
        const skill = item.skill ? item.skill : item;
        if (!skill) return;

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete skill '${skill.name}'?`,
            { modal: true },
            "Delete"
        );

        if (confirm === "Delete") {
            await services.skillsManager.deleteSkill(skill.id, skill.scope);
            vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
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

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.exportSkills', async (item?: any) => {
        // If item exists, export specific skill. Otherwise export all.
        const skillId = item?.skill?.id || item?.id;
        await services.skillsManager.exportSkills(skillId ? [skillId] : undefined);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refreshSkills', () => {
        services.treeProviders.skills?.refresh();
    }));
}
