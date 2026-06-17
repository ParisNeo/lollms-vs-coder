import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsServices } from '../lollmsContext';
import { ChatPanel } from './chatPanel/chatPanel';
import { AgentManager } from '../agentManager';
import { Logger } from '../logger';
import { stripThinkingTags } from '../utils';

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
            if (msg.command === 'submit') {
                await this.handleOnboarding(msg.data);
            }
        }, null, this._disposables);
    }

    private async handleOnboarding(data: any) {
        const { destiny, instructions, preferences, pathway } = data;

        // 1. Save Workspace State
        await this.services.discussionManager.context.workspaceState.update('lollms_workspace_onboarded', true);

        // 2. Update Global/Active capabilities
        const caps = this.services.discussionManager.getLastCapabilities();
        caps.profileType = destiny;
        caps.agentMode = destiny === 'agentic';
        await this.services.discussionManager.saveLastCapabilities(caps);

        // 3. AI Graph Generation Pass
        const rawInstructions = instructions || "General software development.";
        const rawPreferences = preferences || "Standard professional development.";

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Mapping Synaptic Engrams & Project DNA...",
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ message: "Analyzing Plain-Text Persona & Project Goals..." });

                const systemPrompt = `You are the Neural Synaptic Architect for the Lollms Memory Vault.
Your goal is to parse raw user text, coding preferences, and project goals, and convert them into a structured set of memory engram nodes following the s:Engram schema.

### 🧊 SOVEREIGN MEMORY ONTOLOGY (TBox Schema)
Classes (Concepts):
- \`s:Engram\`: Represents an individual unit of captured project knowledge, such as an architectural decision, technical fact, or lesson learned.
- \`s:Tag\`: Represents a semantic hub or hashtag used to index and group related units of knowledge.
- \`s:Document\`: Represents an external reference document, web scrape, or research source.
- \`s:Rule\`: Represents an active project constraint, standard, or 'Sovereign Rule' that must be strictly enforced.

Properties (Relationship Predicates):
- \`s:has_tag\` (Subject: \`s:Engram\` | Object: \`s:Tag\`): Links an engram to a semantic hashtag.

### 🧹 COMPLIANCE RULES:
1. **CATEGORIZATION**: 
   - Classify project architectural goals as \`standards\` or \`rules\`.
   - Classify user personal traits (experience, style, formatting) as \`user\`.
2. **TAG HYGIENE**: You are STRICTLY FORBIDDEN from using purely numeric or meaningless short tags (e.g. #10, #333). Generate actual semantic tags (e.g., #pygame, #junior_dev, #readable_code).
3. **WIRING**: Create explicit 'has_tag' predicates linking each engram to its associated tags.
4. **NO PROSE**: Output ONLY the JSON array of objects.

**OUTPUT FORMAT:**
\`\`\`json
[
  {
    "id": "unique_lowercase_id",
    "title": "Short title (2-4 words)",
    "content": "Full concise fact content. Include hashtags like #pygame or #fastapi inside.",
    "category": "standards" | "rules" | "user",
    "importance": 90,
    "predicates": [
      { "verb": "has_tag", "targetId": "tag_name" }
    ]
  }
]
\`\`\``;

                const userPrompt = `### USER RAW INPUTS
Project Goals: "${rawInstructions}"
User Preferences & Style: "${rawPreferences}"

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
                Logger.error("Failed to generate structured engrams from onboarding inputs, falling back to flat write.", err);
                
                // Fallback: Write basic flat engrams if AI parsing crashed
                if (this.services.projectMemoryManager) {
                    await this.services.projectMemoryManager.updateMemory('add', 'project_dna', 'Project DNA & Standards', `## 🧬 PROJECT DNA\n- Objectives: ${rawInstructions}\n- Indentation Standard: 4 spaces\n`, 'standards', 100);
                    await this.services.projectMemoryManager.updateMemory('add', 'user_dna', 'User Persona & Preferences', `## 👤 USER DNA\n- Preferences: ${rawPreferences}\n`, 'user', 95);
                }
            }
        });

        // 4. Create and launch discussion
        const discussion = this.services.discussionManager.createNewDiscussion();
        discussion.title = `Project: ${this.folder.name}`;
        discussion.capabilities = caps;
        await this.services.discussionManager.saveDiscussion(discussion);

        const panel = ChatPanel.createOrShow(this.services, discussion.id);
        panel.setProcessManager(this.services.processManager);
        panel.setContextManager(this.services.contextManager);
        panel.setPersonalityManager(this.services.personalityManager);
        panel.setHerdManager(this.services.herdManager);

        const agent = new AgentManager(
            panel, this.services.lollmsAPI, this.services.contextManager, this.services.gitIntegration,
            this.services.discussionManager, this.services.extensionUri, this.services.codeGraphManager, this.services.skillsManager,
            this.services.toolManager, this.services.rlmDb
        );
        agent.setProcessManager(this.services.processManager);
        agent.projectMemoryManager = this.services.projectMemoryManager;
        agent.personalityManager = this.services.personalityManager;
        panel.setAgentManager(agent);

        await panel.loadDiscussion();
        this.services.treeProviders.discussion?.refresh();

        // 5. Send Initial Pathway Prompt
        let prompt = "";
        if (destiny === 'vibe') {
            prompt = `Let's start building!
Main Ideas: "${rawInstructions}"`;
        } else {
            if (pathway === 'prd') {
                prompt = `Let's draft our **Product Requirements Document (PRD)**.
1. Outline the System Architecture (Model-View-Controller splits).
2. Detail the critical User Flows.
3. Establish the core security parameters (No custom auth, sanitize every input, handle exceptions generically).

*Remember: Coding comes later once the architecture is locked.*`;
            } else {
                prompt = `Let's perform a **Codebase Reconnaissance** scan.
Analyze the complete project structure, identify the key entry points, and summarize the existing code relationships so we have a firm, grounded starting point before any changes are proposed.`;
            }
        }

        panel._panel.reveal();
        await panel.sendMessage({ role: 'user', content: prompt });

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
                .container { max-width: 650px; width: 100%; display: flex; flex-direction: column; gap: 20px; animation: fadeIn 0.3s ease-out; }
                @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
                h1 { font-size: 2.2em; font-weight: 300; margin: 0; display: flex; align-items: center; gap: 12px; color: var(--accent); }
                p { opacity: 0.8; font-size: 13px; margin: 0; }
                .form-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
                label { display: block; font-weight: bold; font-size: 11px; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; }
                textarea { width: 100%; background: var(--input-bg); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 10px 12px; border-radius: 6px; box-sizing: border-box; font-family: inherit; font-size: 13px; margin-bottom: 20px; resize: vertical; }
                textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
                
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
                @keyframes spin { 100% { transform: rotate(360deg); } }
                .spin { animation: spin 1s linear infinite; display: inline-block; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 Welcome to Lollms VS Coder</h1>
                <p>Let's configure your workspace's destiny and extract its core DNA before writing any code.</p>

                <div class="form-card">
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
                        <p class="help-text" style="font-size:10px; opacity:0.6; margin-top:-15px; margin-bottom: 20px;">This gets processed and structured into Project DNA rules and standards.</p>
                    </div>

                    <div class="form-group">
                        <label for="preferences">3. User Persona & Preferences</label>
                        <textarea id="preferences" rows="3" placeholder="e.g., 'I am a junior developer learning embedded C. I prefer very simple, step-by-step code with rich inline comments. I hate over-engineering...'"></textarea>
                        <p class="help-text" style="font-size:10px; opacity:0.6; margin-top:-15px; margin-bottom: 20px;">This establishes your User DNA, guiding how Lollms explains and formats code for you.</p>
                    </div>

                    <!-- Pathway Selection (Only visible for Agentic) -->
                    <div class="pathway-section" id="pathway-panel">
                        <label>4. Select your starting pathway</label>
                        <p style="font-size:11px; opacity:0.7; margin-bottom:10px;">To prevent the "Doom Loop" and desynchronization, coding comes later. We must establish a clean baseline first.</p>
                        <div class="radio-group">
                            <div class="radio-option active" id="opt-prd" onclick="selectPathway('prd')">
                                <input type="radio" name="pathway" value="prd" checked id="r-prd" style="display:none">
                                <div class="radio-text">
                                    <span class="radio-title">📐 Path A: Design the Architecture (PRD)</span>
                                    <span class="radio-desc">Draft the Product Requirements Document (MVC structures, user flows, database models) in the briefing.</span>
                                </div>
                            </div>
                            <div class="radio-option" id="opt-scan" onclick="selectPathway('scan')">
                                <input type="radio" name="pathway" value="scan" id="r-scan" style="display:none">
                                <div class="radio-text">
                                    <span class="radio-title">🔍 Path B: Codebase Reconnaissance</span>
                                    <span class="radio-desc">Scan and build the full code graph to analyze current files and dependencies before proposing changes.</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <button class="btn" id="submit-btn" onclick="submit()"><i class="codicon codicon-check"></i> Initialize Workspace</button>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let selectedDestiny = 'vibe';
                let selectedPathway = 'prd';

                // Synchronize height on textareas to feel cohesive
                document.querySelectorAll('textarea').forEach(el => {
                    el.addEventListener('input', () => {
                        el.style.height = 'auto';
                        el.style.height = el.scrollHeight + 'px';
                    });
                });

                function selectDestiny(val) {
                    selectedDestiny = val;
                    document.getElementById('opt-vibe').classList.toggle('active', val === 'vibe');
                    document.getElementById('opt-agentic').classList.toggle('active', val === 'agentic');
                    document.getElementById('r-vibe').checked = val === 'vibe';
                    document.getElementById('r-agentic').checked = val === 'agentic';

                    const pathwayPanel = document.getElementById('pathway-panel');
                    pathwayPanel.style.display = val === 'agentic' ? 'block' : 'none';
                }

                function selectPathway(val) {
                    selectedPathway = val;
                    document.getElementById('opt-prd').classList.toggle('active', val === 'prd');
                    document.getElementById('opt-scan').classList.toggle('active', val === 'scan');
                    document.getElementById('r-prd').checked = val === 'prd';
                    document.getElementById('r-scan').checked = val === 'scan';
                }

                function submit() {
                    const btn = document.getElementById('submit-btn');
                    if (btn.disabled) return;

                    const instructions = document.getElementById('instructions').value.trim();
                    const preferences = document.getElementById('preferences').value.trim();

                    // Lock UI and show local loading spinner
                    btn.disabled = true;
                    btn.innerHTML = '<i class="codicon codicon-loading spin"></i> Mapping Synaptic Engrams...';

                    document.querySelectorAll('input, textarea, .radio-option').forEach(el => {
                        el.style.pointerEvents = 'none';
                        el.style.opacity = '0.6';
                    });

                    vscode.postMessage({
                        command: 'submit',
                        data: {
                            destiny: selectedDestiny,
                            instructions: instructions,
                            preferences: preferences,
                            pathway: selectedDestiny === 'agentic' ? selectedPathway : 'none'
                        }
                    });
                }
            </script>
        </body>
        </html>`;
    }
}
