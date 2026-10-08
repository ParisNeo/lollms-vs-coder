import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsServices } from '../lollmsContext';
import { ChatPanel } from './chatPanel/chatPanel';
import { AgentManager } from '../agentManager';
import { Logger } from '../logger';
import { stripThinkingTags } from '../utils';
import { getUserPreferenceProfiles, UserPreferenceProfile } from '../registries/profiles';

export interface ArchitecturalProfile {
    id: string;
    name: string;
    objectives: string;
    style: string;
    prefProfileId?: string;
    doctrine?: string;
}

export class OnboardingPanel {
    public static currentPanel: OnboardingPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, services: LollmsServices, folder: vscode.WorkspaceFolder) {
        if (OnboardingPanel.currentPanel) {
            OnboardingPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsOnboarding',
            '🚀 Lollms Workspace Onboarding',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        OnboardingPanel.currentPanel = new OnboardingPanel(panel, extensionUri, services, folder);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private services: LollmsServices, private folder: vscode.WorkspaceFolder) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtmlForWebview();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'submit':
                    if (msg.data && msg.data.saveAsGlobal && msg.data.profileName) {
                        await this.handleSaveGlobalProfile({
                            id: `custom_${Date.now()}`,
                            name: msg.data.profileName,
                            objectives: msg.data.objectives,
                            style: msg.data.style,
                            prefProfileId: msg.data.prefProfileId,
                            doctrine: msg.data.doctrine
                        });
                    }
                    await this.handleOnboarding(msg.data);
                    break;
                case 'initGraphAndGovernor':
                    await this.handleInitGraphAndGovernor(msg.data);
                    break;
                case 'discoverDoctrine':
                    await this.handleDiscoverDoctrine();
                    break;
                case 'exportProfile':
                    await this.handleExportProfile(msg.data);
                    break;
                case 'importProfile':
                    await this.handleImportProfile();
                    break;
                case 'saveGlobalProfile':
                    await this.handleSaveGlobalProfile(msg.profile);
                    break;
                case 'deleteGlobalProfile':
                    await this.handleDeleteGlobalProfile(msg.id);
                    break;
            }
        }, null, this._disposables);

        this.sendInitialDataToWebview().then(() => {
            this.hydrateFormFromCurrentState();
        });
    }

    private async sendInitialDataToWebview() {
        const architecturalProfiles = this.getGlobalProfiles();
        const userPrefProfiles = getUserPreferenceProfiles(vscode.workspace.getConfiguration('lollmsVsCoder'));

        this._panel.webview.postMessage({
            command: 'updateInitialData',
            architecturalProfiles,
            userPrefProfiles
        });
    }

    private async hydrateFormFromCurrentState() {
        if (!this.services.projectMemoryManager) return;

        try {
            const engrams = await this.services.projectMemoryManager.getMemories();
            const projectDna = engrams.find((e: any) => e.id === 'project_dna');
            const userDna = engrams.find((e: any) => e.id === 'user_dna');
            const caps = this.services.discussionManager.getLastCapabilities();
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');

            const cleanContent = (text: string) => {
                if (!text) return "";
                return text
                    .replace(/^## 🧬 PROJECT DNA\n/i, '')
                    .replace(/^## 👤 USER DNA\n/i, '')
                    .replace(/^- Objectives:\s*/i, '')
                    .replace(/^- Preferences:\s*/i, '')
                    .replace(/#[\w_]+/g, '')
                    .trim();
            };

            const userPrefProfileId = caps.userPreferenceProfileId || config.get<string>('defaultUserPreferenceProfileId') || 'clean_craftsman';
            const userPrefText = caps.userPreferences || (userDna ? cleanContent(userDna.content) : config.get<string>('userPreferences') || '');

            const globalDoctrine = this.services.contextManager.getGlobalBriefing();

            this._panel.webview.postMessage({
                command: 'loadProfileData',
                data: {
                    destiny: caps.profileType || (caps.agentMode ? 'agentic' : 'vibe'),
                    instructions: projectDna ? cleanContent(projectDna.content) : '',
                    preferences: userPrefText,
                    prefProfileId: userPrefProfileId,
                    doctrine: globalDoctrine || '',
                    pathway: caps.agentMode ? 'prd' : 'none'
                }
            });
        } catch (e) {
            Logger.debug("Failed to pre-populate onboarding form from active memory", e);
        }
    }

    private getGlobalProfiles(): ArchitecturalProfile[] {
        const defaultProfiles: (ArchitecturalProfile & { doctrine?: string })[] = [
            {
                id: "profile_python_vibe",
                name: "Python Rapid Prototyping (Vibe)",
                objectives: "Build fast, modular Python applications and interactive features (Pygame, lightweight APIs, automation scripts) using clean f-strings, type hints, and modern libraries.",
                style: "Prioritize velocity, clean formatting, and high-fidelity runtime results. Use expressive, self-documenting naming. Prefer pathlib over raw os.path.",
                prefProfileId: "pythonic_pep8",
                doctrine: "- PEP 8 compliance with modern Python 3.11+ type annotations.\n- Keep logic modular and avoid monolith scripts.\n- Fail fast with descriptive custom exceptions.\n- Never hardcode file paths; use relative pathlib paths."
            },
            {
                id: "profile_fastapi_backend",
                name: "FastAPI & PostgreSQL Backend (Production)",
                objectives: "Architect a production-ready, asynchronous REST API using FastAPI, Pydantic v2 schemas, SQLAlchemy/SQLModel ORM, and PostgreSQL with Alembic migrations.",
                style: "Follow Clean Architecture with strict separation of routes, services, schemas, and database models. Use dependency injection for db sessions and auth. Enforce typed request/response models.",
                prefProfileId: "clean_craftsman",
                doctrine: "- All database access must be asynchronous (async/await).\n- Never expose raw database entities directly through API endpoints; always map through Pydantic schemas.\n- Enforce parameterized queries to eliminate SQL injection.\n- Validate and sanitize all external query parameters."
            },
            {
                id: "profile_react_ts",
                name: "React TypeScript & Tailwind (Modern Web)",
                objectives: "Build accessible, highly responsive frontend interfaces using React, TypeScript strict mode, Tailwind CSS utility classes, and custom state hooks.",
                style: "Component-driven design with small, single-purpose components. Never use 'any'. Enforce readonly prop interfaces, semantic HTML5, and keyboard accessibility (WCAG AA).",
                prefProfileId: "strict_typescript",
                doctrine: "- Strict TypeScript typing with zero implicit or explicit 'any'.\n- Reusable functional components with immutable state paradigms.\n- Semantic HTML5 structure with proper ARIA attributes for screen readers.\n- Graceful async handling with loading, error, and empty states."
            },
            {
                id: "profile_vue_frontend",
                name: "Vue 3 & Vite (Composition API)",
                objectives: "Develop performant, modular web frontends using Vue 3 `<script setup>` Single-File Components (SFC), Pinia state management, and modern CSS/Tailwind utilities.",
                style: "Use Vue 3 Composition API with `<script setup lang=\"ts\">`. Structure components into atomic presentation and smart container layers. Avoid mutating props directly.",
                prefProfileId: "fullstack_modern",
                doctrine: "- Strict `<script setup lang=\"ts\">` on all Vue components.\n- Centralize global state strictly in Pinia stores with typed actions.\n- Keep template logic clean; compute derived data with `computed()`.\n- Emit typed events instead of direct parent-child mutation."
            },
            {
                id: "profile_rust_systems",
                name: "Rust Systems & CLI (Zero-Cost)",
                objectives: "Develop memory-safe, ultra-low-latency system utilities, CLI tools (Clap), and asynchronous services (Tokio) without garbage collection.",
                style: "Embrace idiomatic ownership and borrowing rules. Eliminate unneeded clones. Use exhaustive pattern matching and return `Result<T, E>` / `Option<T>` for error handling instead of unwrap().",
                prefProfileId: "rust_systems",
                doctrine: "- Strict memory safety: no `unsafe` blocks without documented proof invariants.\n- Zero panics in runtime paths; handle all errors via `Result`.\n- Implement deterministic RAII resource cleanup.\n- Keep allocations off the critical performance path."
            }
        ];

        const saved = this.services.discussionManager.context.globalState.get<ArchitecturalProfile[]>('lollms_saved_architectural_profiles', []);
        return [...defaultProfiles, ...saved];
    }

    private async handleSaveGlobalProfile(profile: ArchitecturalProfile) {
        const saved = this.services.discussionManager.context.globalState.get<ArchitecturalProfile[]>('lollms_saved_architectural_profiles', []);
        const cleanProfile = {
            ...profile,
            id: `custom_${Date.now()}`
        };
        saved.push(cleanProfile);
        await this.services.discussionManager.context.globalState.update('lollms_saved_architectural_profiles', saved);
        vscode.window.showInformationMessage(`Architectural profile "${profile.name}" saved globally.`);
        await this.sendInitialDataToWebview();
    }

    private async handleDeleteGlobalProfile(id: string) {
        if (id.startsWith('profile_')) {
            vscode.window.showWarningMessage("Cannot delete core system profiles.");
            return;
        }
        let saved = this.services.discussionManager.context.globalState.get<ArchitecturalProfile[]>('lollms_saved_architectural_profiles', []) || [];
        saved = saved.filter((p: any) => p.id !== id);
        await this.services.discussionManager.context.globalState.update('lollms_saved_architectural_profiles', saved);

        vscode.window.showInformationMessage("Profile removed from library.");
        await this.sendInitialDataToWebview();
    }

    private async handleExportProfile(data: any) {
        const { name, objectives, style, prefProfileId } = data;
        const profile = {
            version: 1,
            name: name || "Custom Architectural Profile",
            objectives,
            style,
            prefProfileId
        };

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('lollms_architectural_profile.json'),
            filters: { 'JSON Profile': ['json'] },
            saveLabel: 'Export Profile'
        });

        if (uri) {
            try {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(profile, null, 2), 'utf8'));
                vscode.window.showInformationMessage(`Profile exported successfully to: ${path.basename(uri.fsPath)}`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to export profile: ${e.message}`);
            }
        }
    }

    private async handleImportProfile() {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'JSON Profile': ['json'] },
            openLabel: 'Import Profile'
        });

        if (uris && uris[0]) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uris[0]);
                const profile = JSON.parse(Buffer.from(bytes).toString('utf8'));

                if (profile && typeof profile === 'object') {
                    this._panel.webview.postMessage({
                        command: 'loadProfileData',
                        data: {
                            name: profile.name || '',
                            objectives: profile.objectives || '',
                            style: profile.style || '',
                            prefProfileId: profile.prefProfileId || 'clean_craftsman'
                        }
                    });
                    vscode.window.showInformationMessage(`Profile imported successfully from: ${path.basename(uris[0].fsPath)}`);
                } else {
                    throw new Error("Invalid file structure.");
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to import profile: ${e.message}`);
            }
        }
    }

    private async handleDiscoverDoctrine() {
        const folder = this.folder;
        if (!folder) return;

        const candidateFiles = [
            'package.json', 'tsconfig.json', 'requirements.txt', 'pyproject.toml',
            'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'README.md',
            'ARCHITECTURE.md', 'CONTRIBUTING.md', '.env.example', 'Makefile'
        ];

        const snippets: string[] = [];
        for (const fileName of candidateFiles) {
            try {
                const fileUri = vscode.Uri.joinPath(folder.uri, fileName);
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                const text = Buffer.from(bytes).toString('utf8');
                if (text.trim()) {
                    snippets.push(`--- ${fileName} ---\n${text.substring(0, 1500)}`);
                }
            } catch {}
            if (snippets.length >= 6) break;
        }

        const existingBriefing = this.services.contextManager.getGlobalBriefing();
        if (existingBriefing) {
            snippets.push(`--- Existing Global Doctrine ---\n${existingBriefing}`);
        }

        const prompt = `You are a Lead Software Architect and Doctrine Officer.
Analyze the following project files and configuration snippets:

${snippets.join('\n\n') || "No manifest files detected in root."}

TASK:
Extract the non-negotiable architectural constraints, framework requirements, and coding doctrine of this project.
Formulate a high-density, authoritative list of 4-7 strict constraints (e.g., target frameworks, typing strictness, prohibited libraries, architectural boundaries).

### 🏛️ IMMUTABILITY MANDATE:
A doctrine is an immutable constitution that constrains developers. NEVER include mutable metadata such as project release versions (e.g., no "v1.0.0" or "v0.8.6"), dates, authors, or temporary task statuses.

Output ONLY a bulleted list of constraints. No conversational chatter.`;

        try {
            const model = this.services.lollmsAPI.getModelName();
            const response = await this.services.lollmsAPI.sendChat([
                { role: 'system', content: "You are a software architect extracting strict project doctrine. Output only bullet points." },
                { role: 'user', content: prompt }
            ], null, undefined, model);

            const cleanDoctrine = stripThinkingTags(response).trim();
            this._panel.webview.postMessage({
                command: 'doctrineDiscovered',
                doctrine: cleanDoctrine
            });
        } catch (e: any) {
            Logger.warn("Automated doctrine discovery failed", e);
            this._panel.webview.postMessage({
                command: 'doctrineDiscovered',
                doctrine: `- Enforce Clean Code and SOLID principles.\n- Maintain strict typing with no implicit 'any'.\n- Handle all error boundaries explicitly without swallowing exceptions.`
            });
        }
    }

    /**
     * Dedicated Quick-Init for Graph and Governor File
     */
    private async handleInitGraphAndGovernor(data: any) {
        const folder = this.folder;
        if (!folder) return;

        const { objectives, style, doctrine, destiny, prefProfileId } = data || {};

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Lollms: Compiling Code Architecture Graph & Governor Report for ${folder.name}...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "Parsing AST symbols, method signatures, and docstrings in worker threads..." });

            if (this.services.codeGraphManager) {
                this.services.codeGraphManager.setWorkspaceRoot(folder.uri);
                await this.services.codeGraphManager.buildGraph(undefined, (p) => {
                    progress.report({ message: `${p.status} (${p.percentage}%)` });
                });
                await this.services.codeGraphManager.saveToDiskCache();
            }

            progress.report({ message: "Synthesizing Governor Codebase Guide (.lollms/structure.md)..." });

            let archSummary = "";
            if (this.services.codeGraphManager) {
                archSummary = this.services.codeGraphManager.generateTextSummary();
            }

            const rawObjectives = objectives || "General software development.";
            const rawStyle = style || "Standard professional clean code.";
            const rawDoctrine = doctrine || "";

            const governorFileContent = `# 🏛️ Codebase Architecture & Structure Guide

## 🎯 Project Overview & Objectives
${rawObjectives}

## 🛠️ Destiny & Development Mode
- **Mode**: ${destiny === 'agentic' ? 'Agentic Engineering (Software 3.0 Rigor, TDD, Security Hardened)' : 'Vibe Coding (Rapid Prototyping & Intuition-Led Iteration)'}
- **Developer Style**: ${rawStyle}
- **Preference Profile**: ${prefProfileId || 'clean_craftsman'}

## 📜 Non-Negotiable Project Doctrine & Constraints
${rawDoctrine || '- Enforce Clean Code, SOLID principles, and explicit error handling.\n- Maintain type integrity across all module boundaries.\n- Never hardcode credentials, secrets, or volatile paths.'}

## 🗺️ Architectural Structure & Symbol Map
${archSummary || '(Architecture graph compiled successfully)'}
`;

            const lollmsDir = vscode.Uri.joinPath(folder.uri, '.lollms');
            await vscode.workspace.fs.createDirectory(lollmsDir);
            const structUri = vscode.Uri.joinPath(lollmsDir, 'structure.md');
            await vscode.workspace.fs.writeFile(structUri, Buffer.from(governorFileContent.trim(), 'utf8'));

            const nodesCount = this.services.codeGraphManager?.getGraphData()?.nodes?.length || 0;
            const edgesCount = this.services.codeGraphManager?.getGraphData()?.edges?.length || 0;

            this._panel.webview.postMessage({
                command: 'initGraphAndGovernorComplete',
                nodesCount,
                edgesCount
            });

            if (ChatPanel.currentPanel) {
                ChatPanel.currentPanel.updateContextAndTokens({ isBackgroundSync: false });
            }

            vscode.window.showInformationMessage(`✅ Architecture Graph compiled (${nodesCount} nodes, ${edgesCount} relations) and Governor file (.lollms/structure.md) created!`);
        });
    }

    private async handleOnboarding(data: any) {
        const { destiny, objectives, style, prefProfileId, pathway, doctrine } = data;
        const folder = this.folder;

        await this.services.discussionManager.context.workspaceState.update('lollms_workspace_onboarded', true);

        const caps = this.services.discussionManager.getLastCapabilities();
        caps.profileType = destiny;
        caps.agentMode = destiny === 'agentic';
        caps.userPreferences = style;
        caps.userPreferenceProfileId = prefProfileId;
        await this.services.discussionManager.saveLastCapabilities(caps);

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        if (style) {
            await config.update('userPreferences', style, vscode.ConfigurationTarget.Global);
            await config.update('userInfo.codingStyle', style, vscode.ConfigurationTarget.Global);
        }
        if (prefProfileId) {
            await config.update('defaultUserPreferenceProfileId', prefProfileId, vscode.ConfigurationTarget.Global);
        }

        if (doctrine && doctrine.trim()) {
            await this.services.contextManager.setGlobalBriefing(doctrine.trim());
        }

        const rawObjectives = objectives || "General software development.";
        const rawStyle = style || "Standard professional development.";
        const rawDoctrine = doctrine || "";

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Lollms: Initializing ${folder.name} (Graph, Governor, & Memory)...`,
            cancellable: false
        }, async (progress) => {
            // 1. Build Full Architecture Graph with worker threads, docstrings, and file references
            if (this.services.codeGraphManager) {
                progress.report({ message: "Compiling Architecture Graph with symbol & docstring parser..." });
                this.services.codeGraphManager.setWorkspaceRoot(folder.uri);
                await this.services.codeGraphManager.buildGraph(undefined, (p) => {
                    progress.report({ message: `Graph: ${p.status} (${p.percentage}%)` });
                });
                await this.services.codeGraphManager.saveToDiskCache();
            }

            // 2. Synthesize and Write Governor Guide (.lollms/structure.md)
            progress.report({ message: "Generating Librarian Structure Report (.lollms/structure.md)..." });
            let archSummary = "";
            if (this.services.codeGraphManager) {
                archSummary = this.services.codeGraphManager.generateTextSummary();
            }

            const projectName = folder.name;
            const rootKnowledgeContent = `# ${projectName}

## Abstract
${rawObjectives}

${rawDoctrine || '- Enforce Clean Code, SOLID principles, and explicit error handling.\n- Maintain type integrity across all module boundaries.\n- Never hardcode credentials, secrets, or volatile paths.'}

## Index
### Architecture_Overview [1]
### Core_Services [0]
### Configuration_And_Environment [0]
`;

            const lollmsDir = vscode.Uri.joinPath(folder.uri, '.lollms');
            await vscode.workspace.fs.createDirectory(lollmsDir);

            const knowledgeUri = vscode.Uri.joinPath(lollmsDir, 'KNOWLEDGE.md');
            await vscode.workspace.fs.writeFile(knowledgeUri, Buffer.from(rootKnowledgeContent.trim(), 'utf8'));

            const { KnowledgeManager } = require('../knowledgeManager');
            const km = new KnowledgeManager(this.services.discussionManager.context);
            await km.updateKnowledge('Architecture_Overview', `## Architecture Overview\n\n${archSummary || 'Initial architecture map compiled.'}`, folder);

            // 3. Mapping Synaptic Memory Engrams
            progress.report({ message: "Mapping Synaptic Engrams & Project DNA..." });
            try {
                const systemPrompt = `You are the Neural Synaptic Architect for the Lollms Memory Vault.
Parse raw user text, coding preferences, and project goals, and convert them into structured s:Engram JSON objects.
Output ONLY valid JSON.`;

                const userPrompt = `### USER RAW INPUTS
Project Goals: "${rawObjectives}"
User Preferences & Style: "${rawStyle}"

Generate a list of structured s:Engram JSON objects mapping these traits.`;

                const model = this.services.lollmsAPI.getModelName();
                const response = await this.services.lollmsAPI.sendChat([
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ], null, undefined, model);

                const cleanJson = stripThinkingTags(response).trim().replace(/```json|```/g, '').trim();
                const engrams = JSON.parse(cleanJson);

                if (Array.isArray(engrams)) {
                    for (const e of engrams) {
                        if (e.id && e.content) {
                            await this.services.projectMemoryManager.updateMemory(
                                'add',
                                e.id,
                                e.title || e.id,
                                e.content,
                                e.category || 'general',
                                e.importance || 80,
                                e.predicates || []
                            );
                        }
                    }
                }
            } catch (err: any) {
                if (this.services.projectMemoryManager) {
                    await this.services.projectMemoryManager.updateMemory('add', 'project_dna', 'Project DNA & Standards', `## 🧬 PROJECT DNA\n- Objectives: ${rawObjectives}\n- Indentation Standard: 4 spaces\n`, 'standards', 100);
                    await this.services.projectMemoryManager.updateMemory('add', 'user_dna', 'User Persona & Preferences', `## 👤 USER DNA\n- Preferences: ${rawStyle}\n`, 'user', 95);
                    if (rawDoctrine) {
                        await this.services.projectMemoryManager.updateMemory('add', 'project_doctrine', 'Project Doctrine & Constraints', `## 🎯 PROJECT DOCTRINE\n${rawDoctrine}\n`, 'rules', 100, [{ verb: 'has_tag', targetId: 'doctrine' }]);
                    }
                }
            }
        });

        this.services.treeProviders.discussion?.refresh();
        vscode.commands.executeCommand('lollmsProjectMemoryView.focus');

        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel.updateContextAndTokens({ isBackgroundSync: false });
        }

        const nodesCount = this.services.codeGraphManager?.getGraphData()?.nodes?.length || 0;
        vscode.window.showInformationMessage(
            `🚀 Project "${this.folder.name}" initialized! Full graph built (${nodesCount} nodes with docstrings) and Governor Guide (.lollms/structure.md) created.`,
            "Ok"
        );

        this.dispose();
    }

    public dispose() {
        OnboardingPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }

    private _getHtmlForWebview() {
        const codiconsUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        
        return `<!DOCTYPE html>
        <html>
        <head>
            <link href="${codiconsUri}" rel="stylesheet" />
            <style>
                :root {
                    --accent: var(--vscode-textLink-foreground);
                    --card-bg: var(--vscode-editorWidget-background);
                    --input-bg: var(--vscode-input-background);
                    --border: var(--vscode-widget-border);
                    --fg: var(--vscode-editor-foreground);
                }
                body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--fg); padding: 40px; line-height: 1.6; display: flex; justify-content: center; }
                .container { max-width: 680px; width: 100%; display: flex; flex-direction: column; gap: 20px; animation: fadeIn 0.3s ease-out; }
                @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
                h1 { font-size: 2.2em; font-weight: 300; margin: 0; display: flex; align-items: center; gap: 12px; color: var(--accent); }
                p { opacity: 0.8; font-size: 13px; margin: 0; }
                .form-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
                label { display: block; font-weight: bold; font-size: 11px; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
                textarea, input[type="text"], select { width: 100%; background: var(--input-bg); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 10px 12px; border-radius: 6px; box-sizing: border-box; font-family: inherit; font-size: 13px; margin-bottom: 20px; resize: vertical; }
                textarea:focus, input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
                
                .radio-group { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; }
                .radio-option { border: 1px solid var(--border); background: var(--vscode-editor-background); padding: 16px; border-radius: 8px; display: flex; align-items: flex-start; gap: 12px; cursor: pointer; transition: all 0.2s; user-select: none; }
                .radio-option:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
                .radio-option.active { border-color: var(--vscode-focusBorder); background: var(--vscode-editor-inactiveSelectionBackground); }
                .radio-option input { margin-top: 3px; cursor: pointer; }
                .radio-text { display: flex; flex-direction: column; gap: 4px; }
                .radio-title { font-weight: bold; font-size: 13px; }
                .radio-desc { font-size: 11px; opacity: 0.7; }
                
                .pathway-section { display: none; margin-top: 15px; border-left: 3px solid var(--vscode-charts-orange); padding-left: 15px; animation: slideDown 0.25s ease-out; }
                @keyframes slideDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }

                .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-weight: bold; width: 100%; font-size: 14px; transition: filter 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
                .btn:hover { filter: brightness(1.1); }
                .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--border); }
                .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
                @keyframes spin { 100% { transform: rotate(360deg); } }
                .spin { animation: spin 1s linear infinite; display: inline-block; }

                .init-feature-box {
                    background: rgba(0, 122, 204, 0.08);
                    border: 1px solid var(--vscode-charts-blue);
                    border-radius: 8px;
                    padding: 14px 16px;
                    margin-bottom: 20px;
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .init-feature-header {
                    font-size: 12px;
                    font-weight: bold;
                    color: var(--vscode-foreground);
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 Welcome to Lollms VS Coder</h1>
                <p>Configure your workspace, compile its architectural code graph, and build the persistent Governor guide.</p>

                <div class="form-card">
                    <div class="init-feature-box">
                        <div class="init-feature-header">
                            <i class="codicon codicon-sparkle" style="color:var(--vscode-charts-blue);"></i>
                            <span>One-Click Project Initialization</span>
                        </div>
                        <p style="font-size:11px; opacity:0.85;">Initializing compiles the complete codebase architecture graph (methods, classes, functions with docstrings), enables single-file incremental updates on edit, and synthesizes the Governor's Codebase Guide (<code>.lollms/structure.md</code>).</p>
                        <div style="display:flex; gap:10px; margin-top:4px;">
                            <button type="button" class="btn secondary" id="btn-quick-init" onclick="quickInit()" style="height:32px; font-size:11px; font-weight:bold; border-color:var(--vscode-charts-blue); color:var(--vscode-textLink-foreground);">
                                <i class="codicon codicon-graph"></i> Build Architecture Graph & Governor File Now
                            </button>
                        </div>
                    </div>

                    <div style="background: rgba(0, 122, 204, 0.05); padding: 15px; border-radius: 8px; border: 1px dashed var(--vscode-widget-border); margin-bottom: 20px;">
                        <label><i class="codicon codicon-library"></i> Load Architectural Profile Template</label>
                        <div style="display:flex; gap:10px;">
                            <select id="global-profile-select" style="margin:0; flex:1;">
                                <option value="">-- Select from Library --</option>
                            </select>
                            <button class="btn secondary" id="delete-profile-btn" style="width:auto; height:36px; padding:0 12px; margin:0; color:var(--vscode-errorForeground);"><i class="codicon codicon-trash"></i></button>
                        </div>
                        <span class="help-text" style="font-size:10px; opacity:0.6; display:block; margin-top:4px;">Populate the forms below using a saved template.</span>
                    </div>

                    <label>1. Define your workspace's destiny</label>
                    <div class="radio-group">
                        <div class="radio-option active" id="opt-vibe" onclick="selectDestiny('vibe')">
                            <input type="radio" name="destiny" value="vibe" checked id="r-vibe" style="display:none">
                            <div class="radio-text">
                                <span class="radio-title">🤠 Vibe Coding</span>
                                <span class="radio-desc">Rapid prototyping, spontaneous ideas, and intuition-led feature development. Best for exploring concepts freely.</span>
                            </div>
                        </div>
                        <div class="radio-option" id="opt-agentic" onclick="selectDestiny('agentic')">
                            <input type="radio" name="destiny" value="agentic" id="r-agentic" style="display:none">
                            <div class="radio-text">
                                <span class="radio-title">🧠 Agentic Engineering</span>
                                <span class="radio-desc">Rigorous architecture-first design under Software 3.0 principles. Mandatory Test-Driven Development (TDD) and security auditing.</span>
                            </div>
                        </div>
                    </div>

                    <div class="form-group">
                        <label for="instructions">2. Project Objectives & Core Ideas</label>
                        <textarea id="instructions" rows="3" placeholder="e.g., A Pygame retro RPG using modular sprites, or a FastAPI backend with PostgreSQL..."></textarea>
                    </div>

                    <div class="form-group">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                            <label for="pref-profile-select" style="margin:0;">3. Developer Preferences Profile</label>
                        </div>
                        <select id="pref-profile-select" style="margin-bottom:8px;">
                            <option value="clean_craftsman">Clean Code & SOLID (Default)</option>
                            <option value="strict_typescript">Strict TypeScript & Immutability</option>
                            <option value="pythonic_pep8">Pythonic, PEP 8 & Modern Type Hints</option>
                            <option value="rust_systems">High-Performance Systems (Rust & C++)</option>
                            <option value="fullstack_modern">Modern Full-Stack & UI/UX Best Practices</option>
                            <option value="security_hardened">Zero-Trust & Security Hardened</option>
                            <option value="tdd_test_first">Test-Driven & High Coverage (TDD)</option>
                            <option value="minimalist_pragmatist">Minimalist & Pragmatic</option>
                            <option value="custom">✏️ Custom Preferences</option>
                        </select>
                        <textarea id="preferences" rows="4" placeholder="e.g., Follow Clean Code and SOLID principles. Keep functions small and single-purpose. Use strict types and explicit error handling..."></textarea>
                    </div>

                    <div class="form-group">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                            <label for="doctrine" style="margin:0;">4. Project Doctrine & Mission Constraints (Non-Negotiables)</label>
                            <button class="btn secondary" id="btn-discover-doctrine" onclick="discoverDoctrine()" style="width:auto; height:26px; padding:0 10px; font-size:11px;">
                                <i class="codicon codicon-sparkle"></i> Auto-Discover Doctrine with AI
                            </button>
                        </div>
                        <textarea id="doctrine" rows="4" placeholder="e.g., - Non-negotiable architectural invariants&#10;- Strict typing and zero 'any'&#10;- Prohibited packages or patterns&#10;- Enforce atomic database operations"></textarea>
                    </div>

                    <div class="checkbox-container" style="margin-bottom: 20px;">
                        <input type="checkbox" id="save-as-global-check" style="width:14px; height:14px; cursor:pointer;">
                        <label for="save-as-global-check" style="font-size:12px; display:inline-block; font-weight:normal;">Save these details as a new template in my Global Library</label>
                    </div>

                    <div class="form-group" id="save-profile-name-group" style="display:none; margin-bottom:20px; animation:slideDown 0.2s ease-out;">
                        <label for="save-profile-name">Global Template Name</label>
                        <input type="text" id="save-profile-name" placeholder="e.g., My Pythonic Style">
                    </div>

                    <div style="display: flex; gap: 10px; margin-bottom: 15px;">
                        <button class="btn secondary" id="import-profile-btn" onclick="importProfile()" style="flex: 1;"><i class="codicon codicon-cloud-upload"></i> Import Profile</button>
                        <button class="btn secondary" id="export-profile-btn" onclick="exportProfile()" style="flex: 1;"><i class="codicon codicon-cloud-download"></i> Export Profile</button>
                    </div>

                    <button class="btn" id="submit-btn" onclick="submit()"><i class="codicon codicon-rocket"></i> Initialize Project (Build Full Graph & Governor File)</button>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let selectedDestiny = 'vibe';
                let selectedPathway = 'prd';
                let globalProfiles = [];
                let userPrefProfiles = [];

                function selectDestiny(val) {
                    selectedDestiny = val;
                    document.getElementById('opt-vibe').classList.toggle('active', val === 'vibe');
                    document.getElementById('opt-agentic').classList.toggle('active', val === 'agentic');
                    document.getElementById('r-vibe').checked = val === 'vibe';
                    document.getElementById('r-agentic').checked = val === 'agentic';
                }

                function selectPathway(val) {
                    selectedPathway = val;
                }

                const saveAsGlobalCheck = document.getElementById('save-as-global-check');
                const saveProfileNameGroup = document.getElementById('save-profile-name-group');
                const saveProfileNameInput = document.getElementById('save-profile-name');

                saveAsGlobalCheck.onchange = () => {
                    saveProfileNameGroup.style.display = saveAsGlobalCheck.checked ? 'block' : 'none';
                    if (saveAsGlobalCheck.checked) {
                        saveProfileNameInput.focus();
                    }
                };

                const globalSelect = document.getElementById('global-profile-select');
                globalSelect.onchange = () => {
                    const selectedIdx = globalSelect.value;
                    if (selectedIdx !== "") {
                        const p = globalProfiles[selectedIdx];
                        if (p) {
                            document.getElementById('instructions').value = p.objectives || '';
                            document.getElementById('preferences').value = p.style || '';
                            if (p.doctrine) {
                                document.getElementById('doctrine').value = p.doctrine;
                            }
                            if (p.prefProfileId) {
                                document.getElementById('pref-profile-select').value = p.prefProfileId;
                            }
                            if (p.id.includes('vibe') || p.id.includes('godot')) {
                                selectDestiny('vibe');
                            } else {
                                selectDestiny('agentic');
                            }
                            syncTextareas();
                        }
                    }
                };

                const prefProfileSelect = document.getElementById('pref-profile-select');
                prefProfileSelect.onchange = () => {
                    const val = prefProfileSelect.value;
                    const matched = userPrefProfiles.find(p => p.id === val);
                    if (matched) {
                        document.getElementById('preferences').value = matched.preferences;
                        syncTextareas();
                    }
                };

                document.getElementById('preferences').addEventListener('input', () => {
                    const currentText = document.getElementById('preferences').value.trim();
                    const matched = userPrefProfiles.find(p => p.preferences.trim() === currentText);
                    prefProfileSelect.value = matched ? matched.id : 'custom';
                });

                document.getElementById('delete-profile-btn').onclick = () => {
                    const idx = globalSelect.value;
                    if (idx !== "") {
                        const p = globalProfiles[idx];
                        if (p && confirm("Delete template '" + p.name + "' from your global library?")) {
                            vscode.postMessage({ command: 'deleteGlobalProfile', id: p.id });
                        }
                    }
                };

                function syncTextareas() {
                    document.querySelectorAll('textarea').forEach(el => {
                        el.style.height = 'auto';
                        el.style.height = el.scrollHeight + 'px';
                    });
                }

                document.querySelectorAll('textarea').forEach(el => {
                    el.addEventListener('input', syncTextareas);
                });

                function exportProfile() {
                    const objectives = document.getElementById('instructions').value.trim();
                    const style = document.getElementById('preferences').value.trim();
                    const prefProfileId = document.getElementById('pref-profile-select').value;

                    vscode.postMessage({
                        command: 'exportProfile',
                        data: {
                            name: saveProfileNameInput.value.trim() || undefined,
                            objectives: objectives,
                            style: style,
                            prefProfileId: prefProfileId
                        }
                    });
                }

                function importProfile() {
                    vscode.postMessage({ command: 'importProfile' });
                }

                function discoverDoctrine() {
                    const btn = document.getElementById('btn-discover-doctrine');
                    if (!btn || btn.disabled) return;
                    btn.disabled = true;
                    btn.innerHTML = '<i class="codicon codicon-loading spin"></i> Discovering Doctrine...';
                    vscode.postMessage({ command: 'discoverDoctrine' });
                }

                function quickInit() {
                    const btn = document.getElementById('btn-quick-init');
                    if (btn) {
                        btn.disabled = true;
                        btn.innerHTML = '<i class="codicon codicon-loading spin"></i> Building Graph & Guide...';
                    }
                    const objectives = document.getElementById('instructions').value.trim();
                    const style = document.getElementById('preferences').value.trim();
                    const doctrine = document.getElementById('doctrine').value.trim();
                    const prefProfileId = document.getElementById('pref-profile-select').value;

                    vscode.postMessage({
                        command: 'initGraphAndGovernor',
                        data: {
                            destiny: selectedDestiny,
                            objectives: objectives,
                            style: style,
                            doctrine: doctrine,
                            prefProfileId: prefProfileId
                        }
                    });
                }

                function submit() {
                    const btn = document.getElementById('submit-btn');
                    if (btn.disabled) return;

                    const objectives = document.getElementById('instructions').value.trim();
                    const style = document.getElementById('preferences').value.trim();
                    const doctrine = document.getElementById('doctrine').value.trim();
                    const prefProfileId = document.getElementById('pref-profile-select').value;
                    const profileName = saveProfileNameInput.value.trim();

                    if (saveAsGlobalCheck.checked && !profileName) {
                        saveProfileNameInput.style.borderColor = 'var(--vscode-errorForeground)';
                        saveProfileNameInput.focus();
                        return;
                    }

                    btn.disabled = true;
                    btn.innerHTML = '<i class="codicon codicon-loading spin"></i> Initializing Project (Graph & Governor)...';

                    document.querySelectorAll('input, textarea, select, .radio-option, button').forEach(el => {
                        el.style.pointerEvents = 'none';
                        el.style.opacity = '0.6';
                    });

                    if (saveAsGlobalCheck.checked) {
                        vscode.postMessage({
                            command: 'saveGlobalProfile',
                            profile: {
                                name: profileName,
                                objectives: objectives,
                                style: style,
                                prefProfileId: prefProfileId,
                                doctrine: doctrine
                            }
                        });
                    }

                    vscode.postMessage({
                        command: 'submit',
                        data: {
                            destiny: selectedDestiny,
                            objectives: objectives,
                            style: style,
                            doctrine: doctrine,
                            prefProfileId: prefProfileId,
                            pathway: selectedDestiny === 'agentic' ? selectedPathway : 'none',
                            saveAsGlobal: saveAsGlobalCheck.checked,
                            profileName: profileName
                        }
                    });
                }

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'loadProfileData') {
                        const d = message.data;
                        if (d.destiny) selectDestiny(d.destiny);
                        document.getElementById('instructions').value = d.instructions || d.objectives || '';
                        document.getElementById('preferences').value = d.preferences || d.style || '';
                        document.getElementById('doctrine').value = d.doctrine || '';
                        if (d.prefProfileId) {
                            document.getElementById('pref-profile-select').value = d.prefProfileId;
                        }
                        if (d.name) {
                            saveAsGlobalCheck.checked = true;
                            saveProfileNameGroup.style.display = 'block';
                            saveProfileNameInput.value = d.name;
                        }
                        syncTextareas();
                    } else if (message.command === 'updateInitialData') {
                        globalProfiles = message.architecturalProfiles || [];
                        userPrefProfiles = message.userPrefProfiles || [];

                        globalSelect.innerHTML = '<option value="">-- Select from Library --</option>';
                        globalProfiles.forEach((p, idx) => {
                            globalSelect.appendChild(new Option(p.name, idx));
                        });

                        prefProfileSelect.innerHTML = userPrefProfiles.map(p => 
                            \`<option value="\${p.id}" \${p.isDefault ? 'selected' : ''}>\${p.name}</option>\`
                        ).join('') + \`<option value="custom">✏️ Custom Preferences</option>\`;
                    } else if (message.command === 'doctrineDiscovered') {
                        const btn = document.getElementById('btn-discover-doctrine');
                        if (btn) {
                            btn.disabled = false;
                            btn.innerHTML = '<i class="codicon codicon-check"></i> Doctrine Discovered';
                        }
                        const doctrineArea = document.getElementById('doctrine');
                        if (doctrineArea && message.doctrine) {
                            doctrineArea.value = message.doctrine;
                            syncTextareas();
                        }
                    } else if (message.command === 'initGraphAndGovernorComplete') {
                        const btn = document.getElementById('btn-quick-init');
                        if (btn) {
                            btn.disabled = false;
                            btn.innerHTML = \`<i class="codicon codicon-check"></i> Graph (\${message.nodesCount} nodes) & Guide Created\`;
                        }
                    } else if (message.command === 'updateGlobalProfiles') {
                        globalProfiles = message.profiles || [];
                        globalSelect.innerHTML = '<option value="">-- Select from Library --</option>';
                        globalProfiles.forEach((p, idx) => {
                            globalSelect.appendChild(new Option(p.name, idx));
                        });
                    }
                });
            </script>
        </body>
        </html>`;
    }
}