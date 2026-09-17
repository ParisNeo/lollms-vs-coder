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
            language: editor.document.languageId,
            category: "lessons_learned",
            scope: "local"
        };

        SkillEditorPanel.createOrShow(services.extensionUri, services.skillsManager, skill as Skill);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.buildSkillFromExperience', async () => {
        const activeDiscussion = ChatPanel.currentPanel?.getCurrentDiscussion();
        const skillPrompt = "Please extract the key architectural rules, technical lessons, and protocols learned from our recent discussion/experience, build a comprehensive skill, and add it to our active context.";

        if (ChatPanel.currentPanel) {
            await ChatPanel.currentPanel.sendMessage({
                role: 'user',
                content: skillPrompt
            });
        } else {
            vscode.window.showInformationMessage("Open a chat panel to extract skills from current experience.");
        }
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
        
        const allSkills = await services.skillsManager.getSkills();
        const toExport = skillId 
            ? allSkills.filter(s => s.id === skillId)
            : allSkills;

        if (toExport.length === 0) {
            vscode.window.showInformationMessage("No skills selected for export.");
            return;
        }

        const folderUri = await vscode.window.showOpenDialog({
            title: "Select Folder to Export Skills",
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false
        });

        if (folderUri && folderUri[0]) {
            for (const skill of toExport) {
                // Export as Format A: Folder with SKILL.md
                const skillFolder = vscode.Uri.joinPath(folderUri[0], skill.id);
                await vscode.workspace.fs.createDirectory(skillFolder);
                const fileUri = vscode.Uri.joinPath(skillFolder, 'SKILL.md');
                
                const fileContent = services.skillsManager.skillToClaudeMarkdown(skill);

                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(fileContent, 'utf8'));
            }
            vscode.window.showInformationMessage(`Exported ${toExport.length} skills to ${folderUri[0].fsPath}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.installZooSkillPrompt', async (skill: Skill) => {
        if (!skill) return;

        const choice = await vscode.window.showQuickPick([
            { label: '$(folder) Install into Project Library', value: 'local', description: 'Available for this project (.lollms/skills)' },
            { label: '$(globe) Install into Global Library', value: 'global', description: 'Available across all projects (~/.lollms/skills)' },
            { label: '$(eye) View Skill Content', value: 'view', description: 'Preview instructions and rules' }
        ], { placeHolder: `Action for "${skill.name}"` });

        if (!choice) return;

        if (choice.value === 'view') {
            const { InfoPanel } = await import('../commands/infoPanel');
            InfoPanel.createOrShow(services.extensionUri, `Skill: ${skill.name}`, `## ${skill.name}\n${skill.description}\n\n\`\`\`${skill.language || 'markdown'}\n${skill.content}\n\`\`\``);
        } else {
            const scope = choice.value as 'global' | 'local';
            try {
                await services.skillsManager.installZooSkill(skill, scope);
                vscode.window.showInformationMessage(`Installed "${skill.name}" into your ${scope === 'global' ? 'Global' : 'Project'} library.`);
                services.treeProviders.skills?.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to install skill: ${err.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.resetSkillsToDefault', async () => {
        const confirm = await vscode.window.showWarningMessage(
            "Are you sure you want to reset all skills and Git repositories to defaults? This will restore the official Skills Zoo (https://github.com/ParisNeo/lollms_skills_zoo.git) and default skills.",
            { modal: true },
            "Reset to Defaults"
        );

        if (confirm === "Reset to Defaults") {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Lollms: Resetting skills to default...",
                cancellable: false
            }, async (progress) => {
                try {
                    await services.skillsManager.resetToDefaultSkills((s: string) => progress.report({ message: s }));
                    vscode.window.showInformationMessage("Skills library and repositories have been reset to defaults.");
                    services.treeProviders.skills?.refresh();
                    if (SkillsManagerPanel.currentPanel) {
                        (SkillsManagerPanel.currentPanel as any)._update();
                    }
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Reset failed: ${err.message}`);
                }
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.refreshSkills', () => {
        services.skillsManager.invalidateCache();
        services.treeProviders.skills?.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.addSkillsRepo', async () => {
        const url = await vscode.window.showInputBox({
            prompt: "Enter Git Repository URL containing skills",
            placeHolder: "https://github.com/ParisNeo/lollms_skills_zoo.git",
            value: "https://github.com/ParisNeo/lollms_skills_zoo.git"
        });

        if (!url) return;

        const defaultName = path.basename(url.trim().replace(/\.git$/, ''));
        const name = await vscode.window.showInputBox({
            prompt: "Enter display name for this repository",
            placeHolder: "e.g. My Team Skills Zoo",
            value: defaultName
        });

        if (!name) return;

        try {
            const repo = await services.skillsManager.addZooRepo(name, url);
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Cloning & Indexing skills from '${name}'...`,
                cancellable: false
            }, async (progress) => {
                const skills = await services.skillsManager.syncZooRepo(repo, status => progress.report({ message: status }));
                vscode.window.showInformationMessage(`Repository '${name}' synchronized. Discovered ${skills.length} skill(s).`);
            });
            services.treeProviders.skills?.refresh();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to add skills repository: ${e.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.syncSkillsZoo', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Syncing all skills Git repositories...",
            cancellable: false
        }, async (progress) => {
            try {
                const results = await services.skillsManager.syncAllZooRepos(status => progress.report({ message: status }));
                const totalSkills = results.reduce((acc, r) => acc + r.skills.length, 0);
                vscode.window.showInformationMessage(`Skills Zoo synchronized: ${totalSkills} skill(s) indexed across ${results.length} repositories.`);
                services.treeProviders.skills?.refresh();
            } catch (e: any) {
                vscode.window.showErrorMessage(`Sync failed: ${e.message}`);
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.manageSkillsRepos', async () => {
        const repos = services.skillsManager.getZooRepos();
        const items = repos.map(r => ({
            label: `$(repo) ${r.name}`,
            description: r.url,
            detail: r.id === 'official_zoo' ? 'Default Official Zoo' : 'Custom Repository',
            repo: r
        }));

        const selected = await vscode.window.showQuickPick(
            [
                { label: '$(add) Add New Git Repository...', action: 'add' } as any,
                { label: '$(sync) Sync All Repositories Now', action: 'sync' } as any,
                ...items
            ],
            { placeHolder: "Manage Skills Git Repositories" }
        );

        if (!selected) return;

        if (selected.action === 'add') {
            vscode.commands.executeCommand('lollms-vs-coder.addSkillsRepo');
        } else if (selected.action === 'sync') {
            vscode.commands.executeCommand('lollms-vs-coder.syncSkillsZoo');
        } else if (selected.repo) {
            const action = await vscode.window.showQuickPick([
                { label: '$(sync) Sync This Repository', id: 'sync' },
                { label: '$(trash) Remove Repository', id: 'delete' }
            ]);

            if (action?.id === 'sync') {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Syncing ${selected.repo.name}...`
                }, async (progress) => {
                    const skills = await services.skillsManager.syncZooRepo(selected.repo, s => progress.report({ message: s }));
                    vscode.window.showInformationMessage(`Found ${skills.length} skills in '${selected.repo.name}'.`);
                });
            } else if (action?.id === 'delete') {
                try {
                    await services.skillsManager.deleteZooRepo(selected.repo.id);
                    vscode.window.showInformationMessage(`Repository '${selected.repo.name}' removed.`);
                } catch (e: any) {
                    vscode.window.showErrorMessage(e.message);
                }
            }
        }
    }));
}
