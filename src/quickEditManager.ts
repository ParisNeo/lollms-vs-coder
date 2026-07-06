import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { InlineDiffProvider } from './commands/inlineDiffProvider';
import { stripThinkingTags, extractAndStripMemory, getProcessedSystemPrompt } from './utils';
import { CompanionPanel } from './commands/companionPanel';
import { ToolDefinition, ToolExecutionEnv } from './tools/tool';
import { searchWebTool } from './tools/builtins/searchWeb';
import { searchArxivTool } from './tools/builtins/searchArxiv';
import { ContextManager } from './contextManager';
import { MemoryManager } from './memoryManager';

export class QuickEditManager {
    private panelDisposables: vscode.Disposable[] = [];

    constructor(
        private lollmsAPI: LollmsAPI,
        private inlineDiffProvider: InlineDiffProvider,
        private contextManager: ContextManager,
        private memoryManager: MemoryManager
    ) {}

    public async triggerQuickEdit() {
        const activeEditor = vscode.window.activeTextEditor;
        const panel = CompanionPanel.createOrShow(
            vscode.extensions.getExtension('parisneo.lollms-vs-coder')!.extensionUri, 
            "Lollms Companion"
        );
        if (activeEditor && activeEditor.document.uri.scheme === 'file') {
            panel.setActiveEditor(activeEditor);
        }

        this.panelDisposables.forEach(d => d.dispose());
        this.panelDisposables = [];
        
        this.panelDisposables.push(panel.onDidSubmit(async (instruction) => {
            await this.processInstruction(instruction, panel);
        }));
    }

    private async processInstruction(payloadString: string, panel: CompanionPanel) {
        let payload = { text: "", mode: "standard" };
        try {
            payload = JSON.parse(payloadString);
        } catch {
            payload = { text: payloadString, mode: "standard" };
        }

        const instruction = payload.text;
        const isGroundingMode = payload.mode === 'grounding';

        const editor = panel.getActiveEditor();
        
        let prompt = "";
        let contextText = "";
        let currentFileBlock = "";
        let hasSelection = false;
        let isNotebook = false;
        let notebookContext = "";
        let languageId = "plaintext";
        let relativePath = "unspecified_file";

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const enableWebSearch = config.get<boolean>('companion.enableWebSearch');
        const enableArxivSearch = config.get<boolean>('companion.enableArxivSearch');
        
        const tools: ToolDefinition[] = [];
        if (enableWebSearch) tools.push(searchWebTool);
        if (enableArxivSearch) tools.push(searchArxivTool);

        panel.setLoading(true);

        try {
            if (isGroundingMode) {
                // --- COMPANION GROUNDING MODE (ALL SELECTED FILES + COMPLETE TREE) ---
                const activeDiscussion = panel.agentManager?.getCurrentDiscussion();
                const importedIds = activeDiscussion?.importedSkills || [];

                const fullContext = await this.contextManager.getContextContent({
                    importedSkillIds: importedIds,
                    includeTree: true,
                    modelName: this.lollmsAPI.getModelName()
                });

                currentFileBlock = `### 🏢 FULL CODEBASE STRUCTURE (ONTOLOGY TREE)\n${fullContext.projectTree}\n\n### 📄 GROUNDED FILE CONTENTS\n${fullContext.selectedFilesContent || "*(No files currently checked in the matrix)*"}`;
                prompt = `**My Question / Message:** "${instruction}"\n\n` +
                            `**COMPLIANCE RULES (MANDATORY):**\n` +
                            `1. You are operating with **Full Grounding Mode** active. You have full vision of our tree and selected files above.\n` +
                            `2. Use AIDER SEARCH/REPLACE blocks if asked to write or modify code for files in the workspace.\n` +
                            `3. For non-workspace code examples, use standard markdown code blocks (e.g. \` \` \`python).\n` +
                            `4. Use our un-validated interaction tools (<open_file />, <set_breakpoint />) proactively to control the editor window.`;
            } else if (editor) {
                const document = editor.document;
                const selection = editor.selection;
                const selectedText = document.getText(selection);
                hasSelection = !selection.isEmpty && selectedText.trim().length > 0;
                languageId = document.languageId;
                relativePath = vscode.workspace.asRelativePath(document.uri);
                
                // Notebook Detection
                isNotebook = document.uri.scheme === 'vscode-notebook-cell';

                if (isNotebook) {
                        const notebookEditor = vscode.window.visibleNotebookEditors.find(ne => 
                        ne.notebook.getCells().some(c => c.document.uri.toString() === document.uri.toString())
                        );
                        if (notebookEditor) {
                            relativePath = vscode.workspace.asRelativePath(notebookEditor.notebook.uri);
                            const currentCell = notebookEditor.notebook.getCells().find(c => c.document.uri.toString() === document.uri.toString());
                            if (currentCell) {
                                relativePath += ` (Cell ${currentCell.index + 1})`;
                                
                                for (const cell of notebookEditor.notebook.getCells()) {
                                if (cell === currentCell) break;
                                const content = cell.document.getText();
                                if (content.length > 2000) continue; 
                                notebookContext += `Cell ${cell.index + 1} (${cell.kind === vscode.NotebookCellKind.Code ? 'Code' : 'Markdown'}):\n\`\`\`\n${content}\n\`\`\`\n\n`;
                                }
                            }
                        }
                    }

                const currentFileCode = document.getText();
                
                // Get all errors/warnings for the ENTIRE file (Grounding Requirement)
                const rawDiagnostics = vscode.languages.getDiagnostics(document.uri);
                let fileErrorsReport = "";
                if (rawDiagnostics.length > 0) {
                    fileErrorsReport = `\n### 🛡️ COMPLETE FILE ERROR & WARNING REPORT\n` +
                        rawDiagnostics.map((d, idx) => {
                            const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 
                                                d.severity === vscode.DiagnosticSeverity.Warning ? 'WARNING' : 'INFO';
                            return `${idx + 1}. **[Line ${d.range.start.line + 1}] [${severity}]**: \`${d.message}\` (${d.source || 'linter'})`;
                        }).join('\n') + `\n`;
                }

                // Compress active debug variables if debugger is active
                const { debugStateManager, debugErrorManager } = require('./extensionState');
                const lastDbgState = debugStateManager.lastState;
                const lastDbgError = debugErrorManager.lastError;
                const dbgLocals = lastDbgState?.locals || lastDbgError?.locals || "";
                let debugReport = "";
                if (dbgLocals) {
                    const lines = dbgLocals.split('\n').filter(Boolean);
                    const compressedLines = lines.map((line: string) => {
                        const parts = line.split(' = ');
                        if (parts.length < 2) return line;
                        const name = parts[0];
                        const valAndType = parts.slice(1).join(' = ');
                        if (valAndType.length > 120) {
                            return `${name} = ${valAndType.substring(0, 100)}... [truncated]`;
                        }
                        return line;
                    });
                    debugReport = `\n### 🐞 ACTIVE DEBUGGER VARIABLES (LOCALS)\n${compressedLines.join('\n')}\n`;
                }

                currentFileBlock = `### 📄 COMPLETE ACTIVE FILE CONTENT\n\`\`\`${languageId}:${relativePath}\n${currentFileCode}\n\`\`\`\n${fileErrorsReport}${debugReport}`;

                if (hasSelection) {
                    const startLine = selection.start.line;
                    const endLine = selection.end.line;

                    prompt = `I am working on the file \`${relativePath}\` (${languageId}).\n\n` +
                                `#### 🔍 SELECTED ZOOM AREA (Lines ${startLine + 1} to ${endLine + 1})\n` +
                                `\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n` +
                                `**Instruction/Question:** "${instruction}"\n\n`;

                    if (isNotebook && notebookContext) {
                        prompt = `**NOTEBOOK CONTEXT (Preceding Cells):**\n${notebookContext}\n\n` + prompt;
                    }

                    prompt += `\n**COMPLIANCE RULES:**\n` +
                                `1. Use AIDER SEARCH/REPLACE blocks for surgical modifications to the active file.\n` +
                                `2. Use FULL FILE blocks if you need to rewrite more than 50% of the file.\n` +
                                `3. You may use the available tools to search the workspace, run queries, or find code.`;
                } else {
                    // Conversational/Casual mode when no text is selected
                    prompt = `I am discussing casually with you. I do not have any code selected to modify.\n\n` +
                                `Current active file in editor (for your reference only): \`${relativePath}\` (${languageId}).\n\n` +
                                `**My Question / Message:** "${instruction}"\n\n` +
                                `**COMPLIANCE RULES (MANDATORY):**\n` +
                                `1. DO NOT output any AIDER search/replace blocks or modify any files on disk.\n` +
                                `2. DO NOT use namespaced code blocks (e.g., do NOT use \` \` \`lang:path\`).\n` +
                                `3. If you write code examples, use standard, non-namespaced markdown blocks (e.g., \` \` \`python or \` \` \`javascript) so they do not trigger any file writes.\n`;
                }
            } else {
                // Grounding when NO editor is open (Conversational Workspace Mode)
                prompt = `I am discussing casually with you. No file editor is currently open in my workspace.\n\n` +
                            `**My Question / Message:** "${instruction}"\n\n` +
                            `**COMPLIANCE RULES (MANDATORY):**\n` +
                            `1. DO NOT output any AIDER search/replace blocks or modify any files on disk.\n`;
            }

            // --- SOVEREIGN SUB-GRAPH EXTRACTION ---
            const graph = this.contextManager['codeGraphManager'];
            let localGraphSummary = "";
            let dependencyContent = "";

            if (graph && graph.getBuildState() === 'ready') {
                const targetNode = graph.getGraphData().nodes.find(n => n.filePath === relativePath);
                if (targetNode) {
                    const depFiles = graph.getGraphData().edges
                        .filter(e => e.source === targetNode.id && e.label === 'imports')
                        .map(e => graph.getGraphData().nodes.find(n => n.id === e.target)?.filePath)
                        .filter((path): path is string => !!path);

                    if (depFiles.length > 0) {
                        dependencyContent = await this.contextManager.readSpecificFiles(depFiles);
                    }
                }

                const deps = graph.getArchitectureAnalysis(relativePath, 'dependencies');
                const usages = graph.getArchitectureAnalysis(relativePath, 'usages');
                localGraphSummary = `### 🗺️ LOCAL ARCHITECTURAL SUB-GRAPH (RELATIONS FOR ${relativePath})\n${deps}\n${usages}\n`;
            }

            const contextData = {
                tree: localGraphSummary,
                files: currentFileBlock + "\n\n### SURGICAL DEPENDENCIES (GROUNDED)\n" + dependencyContent,
                skills: "",
                projectName: vscode.workspace.workspaceFolders?.[0]?.name || "Project"
            };

            let systemPromptContent = await getProcessedSystemPrompt('chat', undefined, undefined, this.memoryManager, false, contextData);

            // Gather friendly user info & Project DNA
            const userConfig = vscode.workspace.getConfiguration('lollmsVsCoder');
            const userName = userConfig.get<string>('userInfo.name') || "Friend";
            const userStyle = userConfig.get<string>('userInfo.codingStyle') || "";

            let projectDNA = "";
            if (this.contextManager.agentManager?.projectMemoryManager) {
                projectDNA = await this.contextManager.agentManager.projectMemoryManager.getFormattedMemoryBlock();
            }

            systemPromptContent += `

### 🎭 PERSONALIZATION PROFILE: BEST CODING FRIEND
- **Identity**: You are Lollms, the user's best coding friend. You are supportive, highly encouraging, and enthusiastic about helping them succeed.
- **Friend**: "${userName}"
- **Preferred Coding Style**: ${userStyle || "Clean, readable, well-commented code."}

\${projectDNA ? \`### 🧬 PROJECT DNA (KNOWLEDGE GROUNDING)\\n\${projectDNA}\\n\` : ""}

### 📡 WORKSPACE INTERACTION RULES (SEAMLESS & AUTONOMOUS)
You have direct, un-validated authority to manipulate the user's editor window and execution state. To perform an action, output the appropriate XML tag verbatim on its own line:

1. **Open/Focus Another File**:
   \`<open_file filePath="relative/path/to/file.ext" line="42" />\`
2. **Select & Highlight Code (Cursor Focus)**:
   \`<select_code filePath="relative/path/to/file.ext" text="exact code string to select" />\`
3. **Set Debug Breakpoint**:
   \`<set_breakpoint filePath="relative/path/to/file.ext" line="42" />\`
4. **Execute/Run Script in Terminal**:
   \`<run_script filePath="relative/path/to/file.ext" />\`

**MANDATE**:
- Call the user by name ("\${userName}") occasionally to make the pairing feel personal and friendly.
- Provide a brief, supportive word ("We got this!", "Let's crack this together!") before diving into the code.
- Align every code change with their preferred coding style and project DNA.
- **PROACTIVE USE**: If the user's instruction asks you to open a file, focus on a section of code, or set a breakpoint, you **MUST** output the corresponding tag immediately in your response so the editor moves instantly. Do not ask for confirmation.
`;

            if (isNotebook) {
                systemPromptContent += `\\n\\n**NOTEBOOK MODE ACTIVATED**
You are an expert Jupyter Notebook assistant.
- You are editing a specific cell (or selection) within a notebook.
- The preceding cells are provided as context.
- When asked to modify code, provide the code block for the CURRENT CELL.
- Do NOT rewrite the entire notebook unless explicitly asked.
- Do NOT include conversational filler if the user asks for a direct replacement.
`;
            }

            // Append only the clean user instruction to the persistent history so the UI stays beautiful
            panel.chatHistory.push({ role: 'user', content: instruction });

            // Construct the final outbound messages array, embedding the full context block specifically
            // into the current turn's payload so the LLM receives the grounding but the UI stays clean.
            const messages: ChatMessage[] = [
                { role: 'system', content: systemPromptContent },
                ...panel.chatHistory.slice(0, -1), // Previous turns
                { role: 'user', content: prompt }  // Current turn with full context
            ];

            // Resolve any active images in a lightweight background pass
            const imageContext = await this.contextManager.getContextContent({ 
                includeTree: false,
                modelName: this.lollmsAPI.getModelName()
            }).catch(() => ({ images: [] }));

            if (imageContext.images && imageContext.images.length > 0) {
                const imageContent = imageContext.images.map((img: any) => ({
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${img.data}` }
                }));
                // Ingest images as user message parts if multi-modal
                const lastUserMsg = messages[messages.length - 1];
                if (lastUserMsg && typeof lastUserMsg.content === 'string') {
                    lastUserMsg.content = [
                        { type: 'text', text: lastUserMsg.content },
                        ...imageContent
                    ] as any;
                }
            }

            let finalResponse = "";
            const controller = new AbortController(); 

            // Render all previous history bubbles on the webview, plus an empty active streaming bubble
            panel._panel.webview.postMessage({ command: 'updateChat', history: panel.chatHistory, streamingText: "" });

            finalResponse = await this.lollmsAPI.sendChat(messages, (chunk) => {
                finalResponse += chunk;
                panel._panel.webview.postMessage({ command: 'updateChat', history: panel.chatHistory, streamingText: finalResponse });
            }, controller.signal);

            const { content: cleanedResponse, memory = null } = extractAndStripMemory(stripThinkingTags(finalResponse));
            if (memory) {
                await this.memoryManager.updateMemory(memory);
            }

            // Commit the complete assistant response to panel's conversation history
            panel.chatHistory.push({ role: 'assistant', content: finalResponse });

            // Send full completed history to webview to replace the temporary streaming bubble with the final styled bubble
            panel._panel.webview.postMessage({ command: 'updateChat', history: panel.chatHistory, streamingText: "" });

            // Also keep standard history logging active
            panel.addHistory(instruction, finalResponse); 

        } catch (error: any) {
            vscode.window.showErrorMessage(`Lollms Companion Error: ${error.message}`);
            panel.setLoading(false);
        } finally {
            panel.setLoading(false);
        }
    }
}
