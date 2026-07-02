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

    private async processInstruction(instruction: string, panel: CompanionPanel) {
        const editor = panel.getActiveEditor();
        if (!editor) {
            vscode.window.showErrorMessage("No active text editor found to apply instructions to.");
            return;
        }

        const document = editor.document;
        const selection = editor.selection;
        const selectedText = document.getText(selection);
        const hasSelection = !selection.isEmpty && selectedText.trim().length > 0;
        const languageId = document.languageId;
        
        // Notebook Detection
        const isNotebook = document.uri.scheme === 'vscode-notebook-cell';
        let relativePath = vscode.workspace.asRelativePath(document.uri);
        let notebookContext = "";

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

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const enableWebSearch = config.get<boolean>('companion.enableWebSearch');
        const enableArxivSearch = config.get<boolean>('companion.enableArxivSearch');
        
        const tools: ToolDefinition[] = [];
        if (enableWebSearch) tools.push(searchWebTool);
        if (enableArxivSearch) tools.push(searchArxivTool);
        const hasTools = tools.length > 0;

        panel.setLoading(true);

        try {
            let prompt = "";
            const contextLines = 20;
            
            const currentFileCode = document.getText();
            const currentFileBlock = `### 📄 ACTIVE FILE CONTENT [C]\n\`\`\`${languageId}:${relativePath}\n${currentFileCode}\n\`\`\`\n`;

            if (hasSelection) {
                const startLine = selection.start.line;
                const endLine = selection.end.line;
                const startContextLine = Math.max(0, startLine - contextLines);
                const endContextLine = Math.min(document.lineCount - 1, endLine + contextLines);
                const rangeBefore = new vscode.Range(new vscode.Position(startContextLine, 0), selection.start);
                const contextBefore = document.getText(rangeBefore);
                const rangeAfter = new vscode.Range(selection.end, new vscode.Position(endContextLine, document.lineAt(endContextLine).text.length));
                const contextAfter = document.getText(rangeAfter);

                prompt = `I am working on the file \`${relativePath}\` (${languageId}).\n\n` +
                            `I have selected code from line ${startLine + 1} to ${endLine + 1}.\n\n` +
                            (contextBefore ? `**Context Before Selection:**\n\`\`\`${languageId}\n${contextBefore}\n\`\`\`\n\n` : '') +
                            `**Selected Code:**\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n` +
                            (contextAfter ? `**Context After Selection:**\n\`\`\`${languageId}\n${contextAfter}\n\`\`\`\n\n` : '') +
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
                         `3. If you write code examples, use standard, non-namespaced markdown blocks (e.g., \` \` \`python or \` \` \`javascript) so they do not trigger any file writes.\n` +
                         `4. Just answer my question casually, friendly, and helpfully as a senior mentor.`;
            }

            // --- SOVEREIGN SUB-GRAPH EXTRACTION ---
            // Only extract complex codebase relationships if the graph is already compiled.
            // This prevents long-running buildGraph tasks from hanging the Companion's initial prompt.
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

${projectDNA ? `### 🧬 PROJECT DNA (KNOWLEDGE GROUNDING)\n${projectDNA}\n` : ""}

**MANDATE**:
- Call the user by name ("${userName}") occasionally to make the pairing feel personal and friendly.
- Provide a brief, supportive word ("We got this!", "Let's crack this together!") before diving into the code.
- Align every code change with their preferred coding style and project DNA.
`;

            if (isNotebook) {
                systemPromptContent += `\n\n**NOTEBOOK MODE ACTIVATED**
You are an expert Jupyter Notebook assistant.
- You are editing a specific cell (or selection) within a notebook.
- The preceding cells are provided as context.
- When asked to modify code, provide the code block for the CURRENT CELL.
- Do NOT rewrite the entire notebook unless explicitly asked.
- Do NOT include conversational filler if the user asks for a direct replacement.
`;
            }

            // Companion is strictly conversational/non-agentic: No tools described or executed.
            const messages: ChatMessage[] = [
                { role: 'system', content: systemPromptContent },
                { role: 'user', content: prompt }
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
                messages.splice(1, 0, { role: 'user', content: imageContent as any });
            }

            let finalResponse = "";
            const controller = new AbortController(); 

            panel._panel.webview.postMessage({ command: 'clearResponse' });

            finalResponse = await this.lollmsAPI.sendChat(messages, (chunk) => {
                panel._panel.webview.postMessage({ command: 'appendChunk', text: chunk });
            }, controller.signal);

            const { content: cleanedResponse, memory = null } = extractAndStripMemory(stripThinkingTags(finalResponse));
            if (memory) {
                await this.memoryManager.updateMemory(memory);
            }

            // Sync with history drawer and set final completed layout with copy/insert/replace controls
            panel.addHistory(instruction, finalResponse); 

        } catch (error: any) {
            vscode.window.showErrorMessage(`Lollms Companion Error: ${error.message}`);
            panel.setLoading(false);
        } finally {
            panel.setLoading(false);
        }
    }
}
