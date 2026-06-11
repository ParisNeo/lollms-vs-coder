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
        const panel = CompanionPanel.createOrShow(
            vscode.extensions.getExtension('parisneo.lollms-vs-coder')!.extensionUri, 
            "Lollms Companion"
        );

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
            
            if (hasSelection) {
                const startLine = selection.start.line;
                const endLine = selection.end.line;
                const startContextLine = Math.max(0, startLine - contextLines);
                const rangeBefore = new vscode.Range(new vscode.Position(startContextLine, 0), selection.start);
                const contextBefore = document.getText(rangeBefore);
                const endContextLine = Math.min(document.lineCount - 1, endLine + contextLines);
                const rangeAfter = new vscode.Range(selection.end, new vscode.Position(endContextLine, document.lineAt(endContextLine).text.length));
                const contextAfter = document.getText(rangeAfter);

                prompt = `I am working on the file \`${relativePath}\` (${languageId}).\n\n` +
                            `I have selected code from line ${startLine + 1} to ${endLine + 1}.\n\n` +
                            (contextBefore ? `**Context Before:**\n\`\`\`${languageId}\n${contextBefore}\n\`\`\`\n\n` : '') +
                            `**Selected Code:**\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n` +
                            (contextAfter ? `**Context After:**\n\`\`\`${languageId}\n${contextAfter}\n\`\`\`\n\n` : '') +
                            `**Instruction/Question:** "${instruction}"\n\n`;
            } else {
                const position = selection.active;
                const startContextLine = Math.max(0, position.line - contextLines);
                const endContextLine = Math.min(document.lineCount - 1, position.line + contextLines);
                const rangeBefore = new vscode.Range(new vscode.Position(startContextLine, 0), position);
                const contextBefore = document.getText(rangeBefore);
                const rangeAfter = new vscode.Range(position, new vscode.Position(endContextLine, document.lineAt(endContextLine).text.length));
                const contextAfter = document.getText(rangeAfter);
                
                prompt = `I am working on the file \`${relativePath}\` (${languageId}).\n\n` +
                            `The cursor is at line ${position.line + 1}, column ${position.character + 1}.\n\n` +
                            (contextBefore ? `**Context Before Cursor:**\n\`\`\`${languageId}\n${contextBefore}\n\`\`\`\n\n` : '') +
                            `**[CURSOR IS HERE]**\n\n` +
                            (contextAfter ? `**Context After Cursor:**\n\`\`\`${languageId}\n${contextAfter}\n\`\`\`\n\n` : '') +
                            `**Instruction/Question:** "${instruction}"\n\n`;
            }

            if (isNotebook && notebookContext) {
                prompt = `**NOTEBOOK CONTEXT (Preceding Cells):**\n${notebookContext}\n\n` + prompt;
            }

            prompt += `Please respond with markdown. If you provide code, use code blocks.`;

            // --- FOCUS GROUNDING: READ CURRENT FILE ONLY ---
            const currentFileCode = document.getText();
            const currentFileBlock = `### 📄 ACTIVE FILE: ${relativePath}\n\`\`\`${languageId}\n${currentFileCode}\n\`\`\`\n`;

            // --- SOVEREIGN SUB-GRAPH EXTRACTION ---
            // Construct a highly focused architectural snapshot representing all links
            // (both incoming usages and outgoing dependencies) of the current file.
            const graph = this.contextManager['codeGraphManager'];
            let localGraphSummary = "";
            let dependencyContent = "";

            if (graph) {
                if (graph.getBuildState() !== 'ready') {
                    await graph.buildGraph();
                }

                const targetNode = graph.getGraphData().nodes.find(n => n.filePath === relativePath);
                if (targetNode) {
                    // Extract all imported/dependent files
                    const depFiles = graph.getGraphData().edges
                        .filter(e => e.source === targetNode.id && e.label === 'imports')
                        .map(e => graph.getGraphData().nodes.find(n => n.id === e.target)?.filePath)
                        .filter((path): path is string => !!path);

                    if (depFiles.length > 0) {
                        dependencyContent = await this.contextManager.readSpecificFiles(depFiles);
                    }
                }

                // Query the graph for relations
                const deps = graph.getArchitectureAnalysis(relativePath, 'dependencies');
                const usages = graph.getArchitectureAnalysis(relativePath, 'usages');
                localGraphSummary = `### 🗺️ LOCAL ARCHITECTURAL SUB-GRAPH (RELATIONS FOR ${relativePath})\n${deps}\n${usages}\n`;
            }

            const contextData = {
                tree: localGraphSummary, // Limit tree context strictly to the local sub-graph connections!
                files: currentFileBlock + "\n\n### SURGICAL DEPENDENCIES (GROUNDED)\n" + dependencyContent,
                skills: "", // Keep companion light, fast, and token-efficient
                projectName: vscode.workspace.workspaceFolders?.[0]?.name || "Project"
            };

            let systemPromptContent = await getProcessedSystemPrompt('chat', undefined, undefined, this.memoryManager, false, contextData);
            if (isNotebook) {
                // Since systemPromptContent is now structured, appending might break structure or just append to Instructions section.
                // The structure ends with Instructions. So appending is safe, it just adds to instructions.
                systemPromptContent += `\n\n**NOTEBOOK MODE ACTIVATED**
You are an expert Jupyter Notebook assistant.
- You are editing a specific cell (or selection) within a notebook.
- The preceding cells are provided as context.
- When asked to modify code, provide the code block for the CURRENT CELL.
- Do NOT rewrite the entire notebook unless explicitly asked.
- Do NOT include conversational filler if the user asks for a direct replacement.
`;
            }

            let systemPrompt = systemPromptContent + 
                "\nYou are Lollms, a helpful AI coding companion. Provide clear, concise answers.";

            if (hasTools) {
                const toolDescriptions = tools.map(t => `${t.name}: ${t.description}`).join('\n');
                systemPrompt += `\n\nAVAILABLE TOOLS:\n${toolDescriptions}\n\n` +
                    `To use a tool, reply ONLY with a valid JSON object in a markdown block like this:\n` +
                    `\`\`\`json\n{"tool": "tool_name", "params": { ... }}\n\`\`\`\n` +
                    `Do not add any other text when invoking a tool. Wait for the tool output in the next message.`;
            }

            const messages: ChatMessage[] = [
                { role: 'system', content: systemPrompt },
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
                // Insert images as a user message part
                messages.splice(1, 0, { role: 'user', content: imageContent as any });
            }

            let finalResponse = "";
            let toolCallLimit = 5;
            
            const controller = new AbortController(); 

            // Clear the panel first before starting the generation stream
            panel._panel.webview.postMessage({ command: 'clearResponse' });

            while (toolCallLimit > 0) {
                let currentChunkBuffer = "";
                let firstToken = false;

                const response = await this.lollmsAPI.sendChat(messages, (chunk) => {
                    if (!firstToken) {
                        firstToken = true;
                    }
                    currentChunkBuffer += chunk;

                    // Stream clean chunks to the Webview in real-time
                    // We strip any thinking tags from the active stream before dispatching
                    const cleanChunk = stripThinkingTags(currentChunkBuffer);
                    const lastToken = cleanChunk.substring(finalResponse.length);

                    if (lastToken) {
                        finalResponse = cleanChunk;
                        panel._panel.webview.postMessage({ command: 'appendChunk', text: lastToken });
                    }
                }, controller.signal);

                const { content: cleanedResponse, memory = null } = extractAndStripMemory(stripThinkingTags(response));
                if (memory) {
                    await this.memoryManager.updateMemory(memory);
                }

                const toolMatch = cleanedResponse.match(/```json\s*(\{[\s\S]*?"tool"[\s\S]*?\})\s*```/);
                
                if (hasTools && toolMatch) {
                    try {
                        const toolCall = JSON.parse(toolMatch[1]);
                        const tool = tools.find(t => t.name === toolCall.tool);
                        
                        if (tool) {
                            messages.push({ role: 'assistant', content: response });

                            const env: ToolExecutionEnv = {
                                lollmsApi: this.lollmsAPI,
                                contextManager: this.contextManager,
                                currentPlan: null,
                            };

                            const result = await tool.execute(toolCall.params, env, controller.signal);
                            messages.push({ role: 'system', content: `Tool Output (${tool.name}):\n${result.output}` });
                            
                            toolCallLimit--;
                            continue;
                        }
                    } catch (e) { }
                }

                finalResponse = cleanedResponse;
                break;
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
