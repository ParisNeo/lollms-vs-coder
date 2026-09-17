import * as vscode from 'vscode';
import * as path from 'path';
import { SkillsManager, Skill, SkillsZooRepo } from '../skillsManager';
import { Logger } from '../logger';

function escapeHtml(str: string): string {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export class SkillsManagerPanel {
    public static currentPanel: SkillsManagerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, manager: SkillsManager) {
        if (SkillsManagerPanel.currentPanel) {
            SkillsManagerPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            SkillsManagerPanel.currentPanel._update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'skillsManager',
            '💡 Skills Library Manager',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        SkillsManagerPanel.currentPanel = new SkillsManagerPanel(panel, extensionUri, manager);
    }

    private async handlePullSkill(skillData: any, targetScope?: 'global' | 'local') {
        try {
            const scope = targetScope || skillData.scope || 'local';
            const installable = {
                ...skillData,
                scope: scope
            };
            const added = await this.manager.addSkill(installable);
            vscode.window.showInformationMessage(`Successfully installed "${added.name}" into your ${scope === 'global' ? 'Global' : 'Project'} skills library.`);
            this._update();
            vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to pull skill: ${e.message}`);
        }
    }

    private async handlePullAllFromRepo(repoId: string) {
        const repo = this.manager.getZooRepos().find((r: SkillsZooRepo) => r.id === repoId);
        if (!repo) return;

        const scopeChoice = await vscode.window.showQuickPick(
            [
                { label: 'Project Library (Local)', value: 'local', description: 'Install into current workspace (.lollms/skills)' },
                { label: 'Global Library', value: 'global', description: 'Install across all projects (~/.lollms/skills)' }
            ],
            { placeHolder: `Install all skills from "${repo.name}" into:` }
        );

        if (!scopeChoice) return;
        const scope = scopeChoice.value as 'global' | 'local';

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Installing all skills from ${repo.name}...`,
            cancellable: false
        }, async () => {
            try {
                const zooRepos = await this.manager.getAllZooSkills();
                const matched = zooRepos.find(r => r.repo.id === repoId);
                const skillsToInstall = matched?.skills || [];

                if (skillsToInstall.length === 0) {
                    vscode.window.showWarningMessage(`No skills found in repository "${repo.name}". Try syncing first.`);
                    return;
                }

                for (const s of skillsToInstall) {
                    await this.manager.installZooSkill(s, scope);
                }

                vscode.window.showInformationMessage(`Successfully installed ${skillsToInstall.length} skill(s) into your ${scope === 'global' ? 'Global' : 'Project'} library.`);
                this._update();
                vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to install skills: ${err.message}`);
            }
        });
    }

    private async handleAddZooRepo() {
        const url = await vscode.window.showInputBox({
            prompt: "Enter Git Repository URL containing skills",
            placeHolder: "https://github.com/ParisNeo/lollms_skills_zoo.git",
            value: "https://github.com/ParisNeo/lollms_skills_zoo.git"
        });

        if (!url) return;

        const defaultName = path.basename(url.trim().replace(/\.git$/, ''));
        const name = await vscode.window.showInputBox({
            prompt: "Enter a display name for this repository",
            placeHolder: "e.g. My Team Skills Zoo",
            value: defaultName
        });

        if (!name) return;

        try {
            const newRepo = await this.manager.addZooRepo(name, url);
            vscode.window.showInformationMessage(`Repository "${name}" added. Synchronizing...`);
            await this.handleSyncZooRepo(newRepo.id);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to add repository: ${e.message}`);
        }
    }

    private async handleDeleteZooRepo(repoId: string) {
        const repo = this.manager.getZooRepos().find((r: SkillsZooRepo) => r.id === repoId);
        if (!repo) return;

        if (repo.id === 'official_zoo') {
            vscode.window.showWarningMessage("Cannot delete the official Lollms Skills Zoo repository.");
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Remove repository "${repo.name}" from your Skills Zoo?`,
            { modal: true },
            "Remove"
        );

        if (confirm === "Remove") {
            try {
                await this.manager.deleteZooRepo(repoId);
                vscode.window.showInformationMessage(`Repository "${repo.name}" removed.`);
                this._update();
                vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to delete repository: ${e.message}`);
            }
        }
    }

    private async handleSyncZooRepo(repoId: string) {
        const repo = this.manager.getZooRepos().find((r: SkillsZooRepo) => r.id === repoId);
        if (!repo) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Syncing: ${repo.name}`,
            cancellable: false
        }, async (progress) => {
            try {
                const skills = await this.manager.syncZooRepo(repo, (status: string) => {
                    progress.report({ message: status });
                });
                vscode.window.showInformationMessage(`Synchronized ${repo.name}. Discovered ${skills.length} skill(s).`);
                this._update();
                vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
                await this.handleExploreZooRepo(repoId);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Git Sync Failed for ${repo.name}: ${e.message}`);
            }
        });
    }

    private async handleExploreZooRepo(repoId: string) {
        const repo = this.manager.getZooRepos().find((r: SkillsZooRepo) => r.id === repoId);
        if (!repo) return;

        try {
            const tree = await this.manager.exploreZooRepo(repo);
            this._panel.webview.postMessage({
                command: 'zooExplored',
                tree: tree,
                repoId: repoId
            });
        } catch (e: any) {
            this._panel.webview.postMessage({
                command: 'zooExplored',
                tree: null,
                repoId: repoId
            });
        }
    }

    private async handleIngestionAction(type: 'claude' | 'document') {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: `Select File to Ingest`,
            filters: type === 'claude' 
                ? { 'Claude Markdown': ['md'] }
                : { 'Documents': ['pdf', 'docx', 'txt', 'md'] }
        });

        if (!uris || !uris[0]) return;

        const scopeChoice = await vscode.window.showQuickPick(
            [{ label: 'Global Library', value: 'global' }, { label: 'Project Library', value: 'local' }],
            { placeHolder: 'Select target library scope' }
        );
        const scope = (scopeChoice?.value as 'global' | 'local') || 'global';

        const fileUri = uris[0];
        const fileName = path.basename(fileUri.fsPath);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Ingesting ${fileName}...`,
            cancellable: false
        }, async () => {
            try {
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                const fileContent = Buffer.from(bytes).toString('utf8');

                if (type === 'claude') {
                    const parsed = this.manager.claudeMarkdownToSkill(fileContent, scope);
                    await this.manager.addSkill(parsed);
                    vscode.window.showInformationMessage(`Claude Skill "${parsed.name}" successfully imported.`);
                } else {
                    let text = "";
                    const ext = path.extname(fileName).toLowerCase();

                    if (ext === '.pdf') {
                        const pdfParse = require('pdf-parse').default || require('pdf-parse');
                        text = (await pdfParse(bytes)).text;
                    } else if (ext === '.docx') {
                        const mammoth = require('mammoth');
                        text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
                    } else {
                        text = fileContent;
                    }

                    const { ChatPanel } = require('./chatPanel/chatPanel');
                    const activeChat = ChatPanel.currentPanel;
                    const lollms = activeChat ? activeChat._lollmsAPI : null;

                    const added = await this.manager.ingestDocumentAsSkill(fileName, text, scope, lollms);
                    if (added) {
                        vscode.window.showInformationMessage(`Document "${fileName}" successfully processed and saved as skill "${added.name}".`);
                    } else {
                        throw new Error("AI extraction yielded invalid format.");
                    }
                }
                this._update();
                vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
            } catch (e: any) {
                vscode.window.showErrorMessage(`Ingestion failed: ${e.message}`);
            }
        });
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private manager: SkillsManager) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._update();

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            const { ChatPanel } = require('./chatPanel/chatPanel');
            const activeChat = ChatPanel.currentPanel;

            switch (msg.command) {
                case 'toggleLoad':
                    if (activeChat && activeChat.getCurrentDiscussion()) {
                        const discussion = activeChat.getCurrentDiscussion()!;
                        if (!discussion.importedSkills) discussion.importedSkills = [];

                        const targetId = String(msg.id).trim();
                        if (msg.load) {
                            if (!discussion.importedSkills.some(id => id.toLowerCase() === targetId.toLowerCase())) {
                                discussion.importedSkills.push(targetId);
                            }
                        } else {
                            discussion.importedSkills = discussion.importedSkills.filter((id: string) => id.toLowerCase() !== targetId.toLowerCase());
                        }

                        await activeChat._discussionManager.saveDiscussion(discussion);

                        // Broadcast immediate context update to the active chat webview
                        const allSkills = await this.manager.getSkills();
                        const activeSkillsForHUD = allSkills.filter(s => 
                            discussion.importedSkills.some(id => id.toLowerCase() === s.id.toLowerCase())
                        );

                        activeChat._panel.webview.postMessage({
                            command: 'updateContext',
                            skills: activeSkillsForHUD
                        });

                        activeChat.updateContextAndTokens();
                        this._update();
                    } else {
                        vscode.window.showWarningMessage("Open a chat discussion first to load/unload skills.");
                        this._update();
                    }
                    break;
                case 'edit':
                    const allSkills = await this.manager.getSkills();
                    const skill = allSkills.find(s => s.id === msg.id);
                    if (skill) {
                        vscode.commands.executeCommand('lollms-vs-coder.editSkill', skill);
                    } else {
                        vscode.window.showErrorMessage(`Lookup failed: Could not find skill with ID: ${msg.id}`);
                    }
                    break;
                case 'delete':
                    const confirmDelete = await vscode.window.showWarningMessage(
                        `Are you sure you want to delete skill "${msg.name}"?`,
                        { modal: true },
                        "Delete"
                    );
                    if (confirmDelete === "Delete") {
                        await this.manager.deleteSkill(msg.id, msg.scope);
                        this._update();
                        vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
                        vscode.window.showInformationMessage(`Skill "${msg.name}" has been deleted.`);
                    }
                    break;
                case 'add':
                    vscode.commands.executeCommand('lollms-vs-coder.addSkill');
                    break;
                case 'refresh':
                    this._update();
                    break;
                case 'wipeAllSkills':
                    const confirmWipe = await vscode.window.showWarningMessage(
                        "Are you sure you want to permanently delete ALL skills (Global and Project)? This cannot be undone.",
                        { modal: true },
                        "Wipe All Skills"
                    );
                    if (confirmWipe === "Wipe All Skills") {
                        await this.manager.deleteAllSkills();
                        this._update();
                        vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
                        vscode.window.showInformationMessage("All skills have been permanently deleted.");
                    }
                    break;
                case 'resetSkillsToDefault':
                    const confirmReset = await vscode.window.showWarningMessage(
                        "Are you sure you want to reset all skills and Git repositories to defaults? This will restore official skills and repositories.",
                        { modal: true },
                        "Reset to Defaults"
                    );
                    if (confirmReset === "Reset to Defaults") {
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: "Lollms: Resetting skills and Git repositories to default...",
                            cancellable: false
                        }, async (progress) => {
                            try {
                                await this.manager.resetToDefaultSkills((status: string) => progress.report({ message: status }));
                                vscode.window.showInformationMessage("Skills library and repositories have been reset to defaults.");
                                this._update();
                                vscode.commands.executeCommand('lollms-vs-coder.refreshSkills');
                            } catch (err: any) {
                                vscode.window.showErrorMessage(`Reset failed: ${err.message}`);
                            }
                        });
                    }
                    break;
                case 'ingestSkill':
                    await this.handleIngestionAction(msg.type);
                    break;
                case 'addZooRepo':
                    await this.handleAddZooRepo();
                    break;
                case 'deleteZooRepo':
                    await this.handleDeleteZooRepo(msg.repoId);
                    break;
                case 'syncZooRepo':
                    await this.handleSyncZooRepo(msg.repoId);
                    break;
                case 'exploreZooRepo':
                    await this.handleExploreZooRepo(msg.repoId);
                    break;
                case 'pullSkillDirect':
                    await this.handlePullSkill(msg.skill, msg.targetScope);
                    break;
                case 'pullAllFromRepo':
                    await this.handlePullAllFromRepo(msg.repoId);
                    break;
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => {
            SkillsManagerPanel.currentPanel = undefined;
            this._disposables.forEach(d => d.dispose());
        }, null, this._disposables);
    }

    private async _update() {
        try {
            const { ChatPanel } = require('./chatPanel/chatPanel');
            const activeChat = ChatPanel.currentPanel;
            const loadedIds = activeChat?.getCurrentDiscussion()?.importedSkills || [];

            const skills = await this.manager.getSkills();
            this._panel.webview.html = this._getHtml(skills, loadedIds);
        } catch (err: any) {
            Logger.error("Failed to render SkillsManagerPanel HTML", err);
            vscode.window.showErrorMessage(`Skills Manager render error: ${err.message}`);
        }
    }

    private _getHtml(skills: Skill[], loadedIds: string[]): string {
        const categories = [...new Set(skills.map(s => s.category || 'Uncategorized'))].sort();
        const zooRepos: SkillsZooRepo[] = this.manager.getZooRepos();

        // Safely Base64 encode the payload into an inert script block to eliminate all quote escaping errors
        const base64Skills = Buffer.from(JSON.stringify(skills), 'utf8').toString('base64');
        const codiconUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css')).toString();

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${this._panel.webview.cspSource}; font-src ${this._panel.webview.cspSource}; script-src 'unsafe-inline';">
            <link href="${codiconUri}" rel="stylesheet" />
            <style>
                body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); margin: 0; padding: 0; background: var(--vscode-editor-background); overflow: hidden; height: 100vh; }
                .layout { display: flex; height: 100vh; width: 100vw; position: relative; }

                .sidebar { width: 290px; background: var(--vscode-sideBar-background); border-right: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; flex-shrink: 0; }
                .sidebar-header { padding: 12px 15px; font-size: 11px; font-weight: bold; text-transform: uppercase; opacity: 0.6; border-bottom: 1px solid var(--vscode-panel-border); display:flex; justify-content:space-between; align-items:center; }
                .category-list { flex: 1; overflow-y: auto; padding: 10px 0; }
                .category-item { padding: 8px 15px; cursor: pointer; font-size: 12px; display: flex; justify-content: space-between; align-items: center; transition: background 0.1s; }
                .category-item:hover { background: var(--vscode-list-hoverBackground); }
                .category-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); font-weight: bold; }
                .cat-count { font-size: 10px; opacity: 0.6; background: var(--vscode-badge-background); padding: 2px 6px; border-radius: 10px; }

                .main { flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative; }
                .header { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); z-index: 100; }

                .search-ribbon { padding: 10px 20px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); display:flex; gap:10px; align-items:center; }
                input#search { flex:1; padding: 8px 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; outline: none; }

                .ingest-toolbar { display:flex; gap:8px; margin-top:5px; padding:0 20px; }

                .content-scroll { flex: 1; overflow-y: auto; padding: 20px; }
                .category-section { margin-bottom: 40px; }
                .category-title { font-size: 13px; font-weight: bold; text-transform: uppercase; color: var(--vscode-textLink-foreground); margin-bottom: 20px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border); display: flex; align-items: center; gap: 8px; }

                .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; }
                .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 8px; display: flex; flex-direction: column; transition: transform 0.1s; position:relative; cursor: pointer; }
                .card:hover { border-color: var(--vscode-focusBorder); transform: translateY(-2px); }
                .card.loaded { border-left: 4px solid var(--vscode-charts-blue); background: rgba(0, 122, 204, 0.05); }
                .name { font-weight: bold; font-size: 1.1em; margin-bottom: 5px; color: var(--vscode-textLink-foreground); }
                .desc { font-size: 0.9em; opacity: 0.8; flex-grow: 1; margin-bottom: 15px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
                .actions { display: flex; gap: 8px; align-items: center; justify-content: space-between; }

                .switch { position: relative; display: inline-block; width: 34px; height: 20px; }
                .switch input { opacity: 0; width: 0; height: 0; }
                .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: var(--vscode-input-background); border: 1px solid var(--vscode-widget-border); transition: .4s; border-radius: 20px; }
                .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 2px; bottom: 2px; background-color: var(--vscode-foreground); transition: .4s; border-radius: 50%; }
                input:checked + .slider { background-color: var(--vscode-button-background); }
                input:checked + .slider:before { transform: translateX(14px); background-color: var(--vscode-button-foreground); }

                button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 12px; display:inline-flex; align-items:center; gap:6px; }
                button:hover { filter: brightness(1.2); }
                button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                button.danger { background: transparent; border: 1px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
                button.danger:hover { background: var(--vscode-errorForeground); color: white; }
                .scope-badge { font-size: 9px; padding: 2px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); text-transform: uppercase; font-weight: bold; }

                .drawer-right { width: 380px; background: var(--vscode-sideBar-background); border-left: 1px solid var(--vscode-panel-border); display: none; flex-direction: column; padding: 20px; box-sizing: border-box; overflow-y: auto; flex-shrink: 0; box-shadow: -5px 0 15px rgba(0,0,0,0.2); }
                .drawer-right.visible { display: flex; }
                .drawer-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 8px; margin-bottom: 15px; }
                .drawer-title { font-weight: bold; font-size: 13px; text-transform: uppercase; color: var(--vscode-textLink-foreground); }
                .spinner { width: 14px; height: 14px; border: 2px solid currentColor; border-bottom-color: transparent; border-radius: 50%; display: inline-block; animation: spin 0.8s linear infinite; }
                @keyframes spin { 100% { transform: rotate(360deg); } }
            </style>
        </head>
        <body>
            <div class="layout">
                <div class="sidebar">
                    <div class="sidebar-header">
                        <span>Browse Library</span>
                        <button class="secondary btn-refresh-lib" title="Refresh Library">↻</button>
                    </div>
                    <div class="category-list">
                        <div class="category-item active" data-category="all">
                            <span>All Active Skills</span>
                            <span class="cat-count">${skills.length}</span>
                        </div>
                        <div class="category-item" data-category="loaded">
                            <span>Loaded in Chat</span>
                            <span class="cat-count" style="background:var(--vscode-charts-blue)">${loadedIds.length}</span>
                        </div>

                        <div style="margin: 10px 15px; height: 1px; background: var(--vscode-panel-border);"></div>
                        <div style="padding: 4px 15px; font-size: 10px; font-weight: bold; opacity: 0.6; display:flex; justify-content:space-between; align-items:center;">
                            <span>GIT REPOSITORIES (ZOO)</span>
                            <button class="secondary" id="btn-add-zoo-repo" style="padding: 2px 6px; font-size: 10px;" title="Add Git Repository"><i class="codicon codicon-add"></i></button>
                        </div>
                        ${zooRepos.map(repo => `
                            <div class="category-item" data-category="zoo_${escapeHtml(repo.id)}" style="display:flex; justify-content:space-between; align-items:center;">
                                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:160px;" title="${escapeHtml(repo.name)} (${escapeHtml(repo.url)})">${escapeHtml(repo.name)}</span>
                                <div style="display:flex; gap:4px;">
                                    <button class="secondary btn-sync-zoo" data-repo-id="${escapeHtml(repo.id)}" style="padding: 2px 5px; font-size: 9px;" title="Sync repository"><i class="codicon codicon-sync"></i></button>
                                    ${repo.id !== 'official_zoo' ? `<button class="danger btn-delete-zoo" data-repo-id="${escapeHtml(repo.id)}" style="padding: 2px 5px; font-size: 9px;" title="Remove repository"><i class="codicon codicon-trash"></i></button>` : ''}
                                </div>
                            </div>
                        `).join('')}

                        <div style="margin: 10px 15px; height: 1px; background: var(--vscode-panel-border);"></div>
                        <div style="padding: 4px 15px; font-size: 10px; font-weight: bold; opacity: 0.6;">CATEGORIES</div>
                        ${categories.map(cat => `
                            <div class="category-item" data-category="${escapeHtml(cat)}">
                                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;">${escapeHtml(cat)}</span>
                                <span class="cat-count">${skills.filter(s => (s.category || 'Uncategorized') === cat).length}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>

                <div class="main">
                    <div class="header">
                        <h2 style="margin:0; font-size:18px;">💡 Skills Library Manager</h2>
                        <div style="display:flex; gap:10px; align-items:center;">
                            <button class="danger" id="btn-wipe-all-skills" title="Permanently delete all skills in global and local storage"><i class="codicon codicon-trash"></i> Wipe All Skills</button>
                            <button class="secondary" id="btn-reset-defaults" title="Reset all skills and Git repositories to default"><i class="codicon codicon-discard"></i> Reset to Defaults</button>
                            <button id="btn-add-skill">+ New Skill</button>
                        </div>
                    </div>

                    <div class="search-ribbon">
                        <input type="text" id="search" placeholder="Search across names, descriptions, or file contents (Grep)...">
                        <button class="secondary" id="search-mode-btn"><i class="codicon codicon-search"></i> <span id="search-mode-label">Simple</span></button>
                    </div>

                    <div class="ingest-toolbar">
                        <button class="secondary btn-ingest" data-type="claude" title="Import Claude Code style YAML-Frontmatter Markdown"><i class="codicon codicon-markdown"></i> Ingest Claude Skill</button>
                        <button class="secondary btn-ingest" data-type="document" title="Extract and format skill from PDF, DOCX, TXT"><i class="codicon codicon-file-pdf"></i> Ingest Document</button>
                    </div>

                    <div class="content-scroll" id="content-root">
                        <div class="category-section" id="section-loaded" style="display:none;">
                            <div class="category-title" style="color: var(--vscode-charts-blue); border-color: var(--vscode-charts-blue);">
                                <span class="codicon codicon-cloud-download"></span> LOADED IN CURRENT CHAT
                            </div>
                            <div class="grid" id="loaded-grid"></div>
                        </div>

                        <div id="zoo-explorer-area" style="display:none;"></div>

                        <div id="all-categories-area"></div>
                    </div>
                </div>

                <div class="drawer-right" id="drawer">
                    <div class="drawer-header">
                        <span class="drawer-title" id="drawer-title-lbl">Skill Details</span>
                        <span style="font-size:24px; cursor:pointer;" id="drawer-close-btn">&times;</span>
                    </div>
                    <div class="form-group" style="margin-bottom:15px;">
                        <label style="font-size:10px; font-weight:bold; opacity:0.6; text-transform:uppercase;">Description</label>
                        <div id="drawer-desc" style="font-size:12px; opacity:0.8; line-height:1.4; margin-top:4px;"></div>
                    </div>
                    <div class="form-group" style="margin-bottom:15px; display:none;" id="drawer-license-group">
                        <label style="font-size:10px; font-weight:bold; opacity:0.6; text-transform:uppercase;"><i class="codicon codicon-shield"></i> LICENSE</label>
                        <pre id="drawer-license" style="font-family:monospace; font-size:10px; background:rgba(0,0,0,0.15); padding:8px; border-radius:4px; max-height:100px; overflow-y:auto; margin:4px 0; border:1px solid var(--vscode-widget-border); white-space:pre-wrap;"></pre>
                    </div>
                    <div class="form-group" style="flex:1; display:flex; flex-direction:column; margin-bottom:15px;">
                        <label style="font-size:10px; font-weight:bold; opacity:0.6; text-transform:uppercase;">Content & Instructions</label>
                        <pre id="drawer-content" style="flex:1; font-family:monospace; font-size:11px; background:rgba(0,0,0,0.25); padding:10px; border-radius:6px; overflow:auto; margin:4px 0; border:1px solid var(--vscode-widget-border); white-space:pre-wrap;"></pre>
                    </div>
                </div>
            </div>

            <!-- INERT DATA SCRIPT (Immune to quote breaking or execution syntax errors) -->
            <script type="application/json" id="skills-data">${base64Skills}</script>

            <script>
                const vscode = acquireVsCodeApi();
                let activeCategory = 'all';
                let searchMode = 'simple';
                let currentActiveRepoId = null;

                const skillsMap = new Map();
                const zooSkillsMap = new Map();
                const loadedSet = new Set(${JSON.stringify(loadedIds)});

                try {
                    const dataEl = document.getElementById('skills-data');
                    const decodedStr = decodeURIComponent(escape(window.atob(dataEl.textContent.trim())));
                    const parsed = JSON.parse(decodedStr);
                    parsed.forEach(s => skillsMap.set(s.id, s));
                } catch (e) {
                    console.error("Failed to decode skills payload", e);
                }

                function escapeHtml(str) {
                    if (!str) return '';
                    return String(str)
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#039;');
                }

                function renderSkillCardHtml(s) {
                    const isLoaded = loadedSet.has(s.id);
                    const safeId = escapeHtml(s.id);
                    const safeName = escapeHtml(s.name);
                    const safeDesc = escapeHtml(s.description || 'No description provided.');
                    const safeScope = escapeHtml(s.scope || 'local');

                    return '<div class="card ' + (isLoaded ? 'loaded' : '') + '" data-id="' + safeId + '" data-is-zoo="false">' +
                        '<div style="display:flex; justify-content:space-between; align-items:start; pointer-events:none;">' +
                            '<div class="name" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:210px;">' + safeName + '</div>' +
                            '<span class="scope-badge">' + safeScope + '</span>' +
                        '</div>' +
                        '<div class="desc" style="pointer-events:none;">' + safeDesc + '</div>' +
                        '<div class="actions">' +
                            '<div style="display:flex; gap:6px;">' +
                                '<button class="btn-edit-skill" data-id="' + safeId + '">Edit</button>' +
                                '<button class="danger btn-delete-skill" data-id="' + safeId + '" data-scope="' + safeScope + '" data-name="' + safeName + '">Delete</button>' +
                            '</div>' +
                            '<div style="display:flex; align-items:center; gap:6px;">' +
                                '<span style="font-size:9px; font-weight:bold; opacity:0.6;">' + (isLoaded ? 'LOADED' : 'OFF') + '</span>' +
                                '<label class="switch">' +
                                    '<input type="checkbox" class="skill-load-toggle" data-id="' + safeId + '" ' + (isLoaded ? 'checked' : '') + '>' +
                                    '<span class="slider"></span>' +
                                '</label>' +
                            '</div>' +
                        '</div>' +
                    '</div>';
                }

                function renderActiveCategories() {
                    const allArea = document.getElementById('all-categories-area');
                    const loadedGrid = document.getElementById('loaded-grid');
                    if (!allArea) return;

                    const categories = new Set();
                    skillsMap.forEach(s => categories.add(s.category || 'Uncategorized'));
                    const sortedCategories = Array.from(categories).sort();

                    let allHtml = '';
                    let loadedCards = '';

                    sortedCategories.forEach(cat => {
                        const catSkills = Array.from(skillsMap.values()).filter(s => (s.category || 'Uncategorized') === cat);
                        allHtml += '<div class="category-section" data-category="' + escapeHtml(cat) + '">' +
                            '<div class="category-title"><span class="codicon codicon-folder"></span> ' + escapeHtml(cat) + '</div>' +
                            '<div class="grid">' +
                                catSkills.map(s => renderSkillCardHtml(s)).join('') +
                            '</div>' +
                        '</div>';
                    });

                    skillsMap.forEach(s => {
                        if (loadedSet.has(s.id)) {
                            loadedCards += renderSkillCardHtml(s);
                        }
                    });

                    allArea.innerHTML = allHtml;
                    if (loadedGrid) loadedGrid.innerHTML = loadedCards;
                }

                renderActiveCategories();

                function selectCategory(el, cat) {
                    document.querySelectorAll('.category-list .category-item').forEach(i => i.classList.remove('active'));
                    el.classList.add('active');
                    activeCategory = cat;

                    const allArea = document.getElementById('all-categories-area');
                    const zooArea = document.getElementById('zoo-explorer-area');

                    if (cat.startsWith('zoo_')) {
                        allArea.style.display = 'none';
                        zooArea.style.display = 'block';
                        const repoId = cat.replace('zoo_', '');
                        currentActiveRepoId = repoId;
                        exploreZoo(repoId);
                    } else {
                        allArea.style.display = 'block';
                        zooArea.style.display = 'none';
                        currentActiveRepoId = null;
                        filter();
                    }
                }

                function toggleSearchMode() {
                    searchMode = searchMode === 'simple' ? 'grep' : 'simple';
                    document.getElementById('search-mode-label').textContent = searchMode === 'simple' ? 'Simple' : 'Deep (Grep)';
                    filter();
                }

                function filter() {
                    const searchInput = document.getElementById('search');
                    const query = (searchInput ? searchInput.value : '').toLowerCase();
                    const sections = document.querySelectorAll('#all-categories-area .category-section');
                    const loadedSection = document.getElementById('section-loaded');

                    if (activeCategory === 'loaded') {
                        if (loadedSection) loadedSection.style.display = 'block';
                        sections.forEach(s => s.style.display = 'none');
                        return;
                    } else {
                        if (loadedSection) loadedSection.style.display = 'none';
                    }

                    sections.forEach(section => {
                        const catMatch = activeCategory === 'all' || section.dataset.category === activeCategory;
                        if (!catMatch) {
                            section.style.display = 'none';
                            return;
                        }

                        let hasVisible = false;
                        section.querySelectorAll('.card').forEach(card => {
                            const id = card.dataset.id;
                            const skill = skillsMap.get(id);
                            if (!skill) return;

                            let match = (skill.name + ' ' + (skill.description || '')).toLowerCase().includes(query);
                            if (searchMode === 'grep' && query.length > 2) {
                                match = match || skill.content.toLowerCase().includes(query);
                            }

                            card.style.display = match ? 'flex' : 'none';
                            if (match) hasVisible = true;
                        });

                        section.style.display = hasVisible ? 'block' : 'none';
                    });
                }

                function inspectSkill(id) {
                    const skill = skillsMap.get(id);
                    if (!skill) return;
                    showDrawer(skill.name, skill.description, skill.content);
                }

                function inspectZooSkill(id) {
                    const skill = zooSkillsMap.get(id);
                    if (!skill) return;
                    showDrawer('Zoo: ' + skill.name, skill.description, skill.content, skill.license);
                }

                function showDrawer(title, desc, content, license) {
                    document.getElementById('drawer-title-lbl').textContent = title;
                    document.getElementById('drawer-desc').textContent = desc || "No description provided.";
                    document.getElementById('drawer-content').textContent = content;

                    const licGroup = document.getElementById('drawer-license-group');
                    if (license) {
                        licGroup.style.display = 'block';
                        document.getElementById('drawer-license').textContent = license;
                    } else {
                        licGroup.style.display = 'none';
                    }

                    document.getElementById('drawer').classList.add('visible');
                }

                function closeDrawer() {
                    document.getElementById('drawer').classList.remove('visible');
                }

                function exploreZoo(repoId) {
                    const zooArea = document.getElementById('zoo-explorer-area');
                    zooArea.innerHTML = '<div style="padding:30px; text-align:center;"><div class="spinner"></div> Reading repository cache...</div>';
                    vscode.postMessage({ command: 'exploreZooRepo', repoId: repoId });
                }

                // ==========================================
                // ROBUST CENTRALIZED EVENT DELEGATION
                // (Zero inline onclick handlers = Zero Syntax Errors)
                // ==========================================
                document.addEventListener('click', (e) => {
                    const target = e.target;
                    if (!target) return;

                    // 1. Wipe All Skills button (Dispatches directly to native VS Code modal confirmation)
                    const wipeBtn = target.closest('#btn-wipe-all-skills');
                    if (wipeBtn) {
                        vscode.postMessage({ command: 'wipeAllSkills' });
                        return;
                    }

                    // 2. Reset to Defaults button (Dispatches directly to native VS Code modal confirmation)
                    const resetBtn = target.closest('#btn-reset-defaults');
                    if (resetBtn) {
                        vscode.postMessage({ command: 'resetSkillsToDefault' });
                        return;
                    }

                    // 2. Add New Skill
                    const addSkillBtn = target.closest('#btn-add-skill');
                    if (addSkillBtn) {
                        vscode.postMessage({ command: 'add' });
                        return;
                    }

                    // 3. Refresh Library
                    const refreshBtn = target.closest('.btn-refresh-lib');
                    if (refreshBtn) {
                        vscode.postMessage({ command: 'refresh' });
                        return;
                    }

                    // 4. Ingest Buttons
                    const ingestBtn = target.closest('.btn-ingest');
                    if (ingestBtn) {
                        const type = ingestBtn.dataset.type;
                        if (type) vscode.postMessage({ command: 'ingestSkill', type: type });
                        return;
                    }

                    // 5. Add Zoo Repo
                    const addZooBtn = target.closest('#btn-add-zoo-repo');
                    if (addZooBtn) {
                        vscode.postMessage({ command: 'addZooRepo' });
                        return;
                    }

                    // 6. Sync Zoo Repo
                    const syncZooBtn = target.closest('.btn-sync-zoo');
                    if (syncZooBtn) {
                        e.stopPropagation();
                        const repoId = syncZooBtn.dataset.repoId;
                        if (repoId) vscode.postMessage({ command: 'syncZooRepo', repoId: repoId });
                        return;
                    }

                    // 7. Delete Zoo Repo
                    const delZooBtn = target.closest('.btn-delete-zoo');
                    if (delZooBtn) {
                        e.stopPropagation();
                        const repoId = delZooBtn.dataset.repoId;
                        if (repoId) vscode.postMessage({ command: 'deleteZooRepo', repoId: repoId });
                        return;
                    }

                    // 8. Pull All From Repo
                    const pullAllBtn = target.closest('.btn-pull-all-repo');
                    if (pullAllBtn) {
                        if (currentActiveRepoId) {
                            vscode.postMessage({ command: 'pullAllFromRepo', repoId: currentActiveRepoId });
                        }
                        return;
                    }

                    // 9. Pull Individual Zoo Skill
                    const pullSkillBtn = target.closest('.btn-pull-skill');
                    if (pullSkillBtn) {
                        e.stopPropagation();
                        const skillId = pullSkillBtn.dataset.skillId;
                        const targetScope = pullSkillBtn.dataset.scope || 'local';
                        const skill = zooSkillsMap.get(skillId);
                        if (skill) {
                            vscode.postMessage({ command: 'pullSkillDirect', skill: skill, targetScope: targetScope });
                        }
                        return;
                    }

                    // 10. Edit Skill
                    const editBtn = target.closest('.btn-edit-skill');
                    if (editBtn) {
                        e.stopPropagation();
                        const id = editBtn.dataset.id;
                        if (id) vscode.postMessage({ command: 'edit', id: id });
                        return;
                    }

                    // 11. Delete Skill
                    const deleteBtn = target.closest('.btn-delete-skill');
                    if (deleteBtn) {
                        e.stopPropagation();
                        const id = deleteBtn.dataset.id;
                        const scope = deleteBtn.dataset.scope;
                        const name = deleteBtn.dataset.name;
                        if (id) vscode.postMessage({ command: 'delete', id: id, scope: scope, name: name });
                        return;
                    }

                    // 12. Search mode toggle
                    const searchModeBtn = target.closest('#search-mode-btn');
                    if (searchModeBtn) {
                        toggleSearchMode();
                        return;
                    }

                    // 13. Drawer close
                    const drawerClose = target.closest('#drawer-close-btn');
                    if (drawerClose) {
                        closeDrawer();
                        return;
                    }

                    // 14. Select Category Item
                    const catItem = target.closest('.category-item');
                    if (catItem) {
                        const cat = catItem.dataset.category;
                        if (cat) selectCategory(catItem, cat);
                        return;
                    }

                    // 15. Inspect Card Click
                    const card = target.closest('.card');
                    if (card) {
                        const id = card.dataset.id;
                        const isZoo = card.dataset.isZoo === 'true';
                        if (isZoo) inspectZooSkill(id);
                        else inspectSkill(id);
                        return;
                    }
                });

                // Toggle load in chat discussion
                document.addEventListener('change', (e) => {
                    const target = e.target;
                    if (target && target.classList.contains('skill-load-toggle')) {
                        const id = target.dataset.id;
                        const isChecked = target.checked;
                        if (isChecked) loadedSet.add(id);
                        else loadedSet.delete(id);
                        vscode.postMessage({ command: 'toggleLoad', id: id, load: isChecked });
                    }
                });

                const searchEl = document.getElementById('search');
                if (searchEl) {
                    searchEl.addEventListener('input', filter);
                }

                window.addEventListener('message', event => {
                    const m = event.data;
                    if (m.command === 'zooExplored') {
                        const zooArea = document.getElementById('zoo-explorer-area');
                        if (!m.tree || !m.tree.children || m.tree.children.length === 0) {
                            zooArea.innerHTML = '<div style="padding:30px; text-align:center; opacity:0.6;"><i class="codicon codicon-cloud-download" style="font-size:32px; display:block; margin-bottom:10px;"></i>No cached skills found for this repository.<br><br><button class="secondary btn-sync-zoo" data-repo-id="' + escapeHtml(m.repoId) + '"><i class="codicon codicon-sync"></i> Synchronize from Remote Git</button></div>';
                            return;
                        }

                        zooSkillsMap.clear();

                        let html = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; border-bottom:1px solid var(--vscode-widget-border); padding-bottom:10px;">' +
                            '<div><h3 style="margin:0 0 4px 0;"><i class="codicon codicon-repo"></i> ' + escapeHtml(m.tree.label) + '</h3><span style="font-size:11px; opacity:0.6;">Discovered Git Skills</span></div>' +
                            '<div style="display:flex; gap:8px;">' +
                                '<button class="secondary btn-pull-all-repo"><i class="codicon codicon-cloud-download"></i> Install All to Library</button>' +
                                '<button class="secondary btn-sync-zoo" data-repo-id="' + escapeHtml(m.repoId) + '"><i class="codicon codicon-sync"></i> Sync</button>' +
                            '</div>' +
                        '</div>';

                        const renderZooNode = (node) => {
                            if (node.isSkill) return '';
                            const subSkills = [];

                            const collectSkills = (n) => {
                                if (n.isSkill) {
                                    subSkills.push(n);
                                    zooSkillsMap.set(n.skill.id, n.skill);
                                } else if (n.children) {
                                    n.children.forEach(collectSkills);
                                }
                            };
                            collectSkills(node);

                            if (subSkills.length === 0) return '';

                            return '<div class="category-section">' +
                                '<div class="category-title"><span class="codicon codicon-folder"></span> ' + escapeHtml(node.label) + ' (' + subSkills.length + ' available)</div>' +
                                '<div class="grid">' +
                                    subSkills.map(s => {
                                        const sId = escapeHtml(s.skill.id);
                                        return '<div class="card" data-id="' + sId + '" data-is-zoo="true">' +
                                            '<div class="name">' + escapeHtml(s.label) + '</div>' +
                                            '<div class="desc">' + escapeHtml(s.description || 'No description provided.') + '</div>' +
                                            '<div class="actions">' +
                                                '<div style="display:flex; gap:6px;">' +
                                                    '<button class="btn-pull-skill" data-skill-id="' + sId + '" data-scope="local" title="Install into Project (.lollms/skills)"><i class="codicon codicon-plus"></i> Project</button>' +
                                                    '<button class="secondary btn-pull-skill" data-skill-id="' + sId + '" data-scope="global" title="Install into Global (~/.lollms/skills)"><i class="codicon codicon-globe"></i> Global</button>' +
                                                '</div>' +
                                                (s.license ? '<span class="scope-badge">Licensed</span>' : '') +
                                            '</div>' +
                                        '</div>';
                                    }).join('') +
                                '</div>' +
                            '</div>';
                        };

                        html += m.tree.children.map(renderZooNode).join('');
                        zooArea.innerHTML = html;
                    }
                });
            </script>
        </body>
        </html>`;
    }
}