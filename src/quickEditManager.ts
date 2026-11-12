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
        private memoryManager: MemoryManager,
        private extensionUri?: vscode.Uri,
        private discussionManager?: any
    ) {}

    public async triggerQuickEdit() {
        let activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || (activeEditor.document.uri.scheme !== 'file' && activeEditor.document.uri.scheme !== 'vscode-notebook-cell')) {
            activeEditor = vscode.window.visibleTextEditors.find(e => 
                e.document.uri.scheme === 'file' || e.document.uri.scheme === 'vscode-notebook-cell'
            );
        }
        const extUri = this.extensionUri || vscode.extensions.getExtension('parisneo.lollms-vs-coder')?.extensionUri;
        if (!extUri) {
            vscode.window.showErrorMessage("Failed to locate extension URI for Lollms Companion.");
            return;
        }

        const panel = CompanionPanel.createOrShow(extUri, "Lollms Companion");
        panel.agentManager = this.contextManager?.agentManager;
        panel.discussionManager = this.discussionManager;

        if (activeEditor) {
            panel.setActiveEditor(activeEditor);
        }

        this.panelDisposables.forEach(d => d.dispose());
        this.panelDisposables = [];
        
        this.panelDisposables.push(panel.onDidSubmit(async (instruction) => {
            await this.processInstruction(instruction, panel);
        }));
    }

    private async processInstruction(payloadString: string, panel: CompanionPanel) {
        let payload = { text: "" };
        try {
            payload = JSON.parse(payloadString);
        } catch {
            payload = { text: payloadString };
        }

        const instruction = (payload.text || "").trim();
        if (!instruction) {
            panel.setLoading(false);
            return;
        }

        const editor = panel.getActiveEditor();
        let prompt = "";
        let currentFileBlock = "";
        let isNotebook = false;
        let notebookContext = "";
        let languageId = "plaintext";
        let relativePath = "unspecified_file";

        const userMsgId = 'user_' + Date.now();
        panel.chatHistory.push({ id: userMsgId, role: 'user', content: instruction });
        panel._panel.webview.postMessage({ command: 'updateChat', history: panel.chatHistory, streamingText: "" });
        panel.setLoading(true);

        try {
            if (editor) {
                const document = editor.document;
                languageId = document.languageId;
                
                // Multi-root and external folder path resolution
                const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                if (wsFolder) {
                    const isMultiRoot = (vscode.workspace.workspaceFolders || []).length > 1;
                    relativePath = isMultiRoot
                        ? `${wsFolder.name}/${path.relative(wsFolder.uri.fsPath, document.uri.fsPath).replace(/\\/g, '/')}`
                        : path.relative(wsFolder.uri.fsPath, document.uri.fsPath).replace(/\\/g, '/');
                } else if (document.uri.scheme === 'file') {
                    relativePath = document.uri.fsPath.replace(/\\/g, '/');
                } else {
                    relativePath = vscode.workspace.asRelativePath(document.uri);
                }
                
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
                const lastDbgState = debugStateManager?.lastState;
                const lastDbgError = debugErrorManager?.lastError;
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

                currentFileBlock = `### 📄 COMPLETE ACTIVE FILE CONTENT\n<file path="${relativePath}">\n${currentFileCode}\n</file>\n${fileErrorsReport}${debugReport}`;

                prompt = `I am working on the file \`${relativePath}\` (${languageId}).\n\n` +
                         (isNotebook && notebookContext ? `**NOTEBOOK CONTEXT (Preceding Cells):**\n${notebookContext}\n\n` : '') +
                         `**Instruction/Question:** "${instruction}"\n\n` +
                         `**MANDATORY FILE PATCHING PROTOCOL:**\n` +
                         `1. Whenever the instruction asks to update, modify, enhance, fix, add, or rewrite ANY code, docstring, comment, or function in \`${relativePath}\`:\n` +
                         `   You MUST output the code modification using a top-level \`<file path="${relativePath}" action="patch">\` XML tag containing exact Aider SEARCH/REPLACE blocks:\n` +
                         `   <file path="${relativePath}" action="patch">\n` +
                         `   <<<<<<< SEARCH\n` +
                         `   [exact existing lines from the file to replace]\n` +
                         `   =======\n` +
                         `   [new updated/enhanced lines]\n` +
                         `   >>>>>>> REPLACE\n` +
                         `   </file>\n\n` +
                         `   CRITICAL: DO NOT output bare markdown code fences (like \`\`\`${languageId}) for code or docstring updates! The user applies your changes by clicking the "Patch" button on the generated card to review diffs in their editor. If you do not use the <file> tag, the user CANNOT patch their file or view diffs.\n` +
                         `2. The SEARCH block MUST match the lines currently in the file character-for-character, including exact indentation, punctuation, and surrounding context.\n` +
                         `3. For brand-new files, use \`<file path="path/to/new_file.ext" action="write">\`.\n` +
                         `4. To navigate or highlight code in the current file without editing, output:\n` +
                         `   <focuse>\n` +
                         `   exact code to focuse on\n` +
                         `   </focuse>\n` +
                         `5. If you need to search or inspect other parts of the workspace, you can execute inline tools: <grep query="..." />, <sparql query="..." />, <peek_files path="..." lines="30" />, or <read_full_file path="..." />.\n` +
                         `6. ONLY respond with plain markdown if the request is purely an informational question (e.g., "what does this function do?") that requires zero code or docstring changes.`;
            } else {
                prompt = `I am discussing with you. No file editor is currently open in my workspace.\n\n` +
                         `**My Question / Message:** "${instruction}"\n\n` +
                         `**COMPLIANCE RULES:**\n` +
                         `1. If I ask to create a new file, output \`<file path="path/to/file.ext" action="write">\`.\n` +
                         `2. You can search the workspace using <grep query="..." /> or <sparql query="..." />.\n` +
                         `3. Use standard markdown blocks for general explanations and examples.\n`;
            }

            // --- LOCAL SUB-GRAPH EXTRACTION ---
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
                files: currentFileBlock + (dependencyContent ? "\n\n### SURGICAL DEPENDENCIES (GROUNDED)\n" + dependencyContent : ""),
                skills: "",
                projectName: vscode.workspace.workspaceFolders?.[0]?.name || "Project"
            };

            let systemPromptContent = await getProcessedSystemPrompt('chat', undefined, undefined, this.memoryManager, false, contextData);

            const userConfig = vscode.workspace.getConfiguration('lollmsVsCoder');
            const userName = userConfig.get<string>('userInfo.name') || "Developer";
            const userStyle = userConfig.get<string>('userInfo.codingStyle') || "";

            let projectDNA = "";
            if (this.contextManager.agentManager?.projectMemoryManager) {
                projectDNA = await this.contextManager.agentManager.projectMemoryManager.getFormattedMemoryBlock(instruction, undefined, panel.discussionManager?.getLastDiscussionId?.());
            }

            systemPromptContent += `

### 🎭 PERSONALIZATION PROFILE: EXPERT CODING COMPANION
- **Identity**: You are Lollms Companion, a senior peer software engineer working alongside ${userName}.
- **Focus**: You are dedicated to the current file (\`${relativePath}\`).
- **Tone**: Direct, concise, technical, professional, and helpful.
- **Coding Style**: ${userStyle || "Clean, idiomatic, production-ready code (SOLID, DRY, KISS)."}

${projectDNA ? `### 🧬 PROJECT STANDARDS\n${projectDNA}\n` : ""}

### 🛠️ MANDATORY PATCHING INSTRUCTION FOR CODE & DOCSTRING UPDATES
When the user asks to modify, update, enhance, fix, refactor, or add code or docstrings to \`${relativePath}\`:
- You MUST wrap your code updates in:
<file path="${relativePath}" action="patch">
You have direct authority to navigate the user's editor, explore the codebase, and execute queries. To perform an action, output the appropriate XML tag on its own line:

1. **Focus on Code in Current File (Highlight & Scroll to Code)**:
   When the user asks where to find something in the current file, or asks you to show/locate/focus on a specific part of the code, output the exact code snippet wrapped in a <focuse> tag with NO attributes or parameters:
   <focuse>
   exact code to focuse on
   </focuse>
   The user's editor will immediately navigate, scroll to, and select that exact code in the active editor. Never use attributes or parameters inside this tag so that no escaping is required.

2. **Grep Code Search Across Workspace**:
   If you need to find where a variable, class, or function is used across the codebase, output:
   <grep query="pattern" path="optional/subfolder" />
   The system will execute the grep search inline and provide the hits so you can continue your answer.

3. **SPARQL Architecture Query**:
   To inspect classes, interfaces, function calls, or file imports from the code graph ontology, output:
   <sparql query="SELECT ?file ?func WHERE { ?file s:containsEntity ?func . ?func a s:FunctionDefinition } LIMIT 25" />
   The system will execute the query and provide the results.

4. **Peek File Slices**:
   To peek at lines in another file without opening it:
   <peek_files path="path/to/other.ext" lines="30" />

5. **Read Full File**:
   To inspect another full file:
   <read_full_file path="path/to/other.ext" />

6. **Open Another File**:
   <open_file filePath="relative/path/to/file.ext" line="42" />

7. **Set Debug Breakpoint**:
   <set_breakpoint filePath="relative/path/to/file.ext" line="42" />

8. **Execute/Run Script in Terminal**:
   <run_script filePath="relative/path/to/file.ext" />

**MANDATE**:
- If the user asks where something is or to focus on code in the current file, you **MUST** output the \`<focuse>\` tag immediately so the editor jumps directly to it.
`;

            if (isNotebook) {
                systemPromptContent += `\n\n**NOTEBOOK MODE ACTIVATED**
You are an expert Jupyter Notebook assistant.
- You are editing a specific cell within a notebook.
- The preceding cells are provided as context.
- When asked to modify code, provide the code block for the CURRENT CELL.
`;
            }

            const messages: ChatMessage[] = [
                { role: 'system', content: systemPromptContent },
                ...panel.chatHistory.slice(0, -1),
                { role: 'user', content: prompt }
            ];

            let finalResponse = "";
            let currentStreaming = "";
            let turnIndex = 0;
            const maxTurns = 8;
            const controller = new AbortController();

            // --- INLINE DISCOVERY & EXECUTION LOOP (GREP / SPARQL / PEEK / READ / TOOLS) ---
            while (turnIndex < maxTurns) {
                turnIndex++;
                let turnResponse = "";

                await this.lollmsAPI.sendChat(messages, (chunk) => {
                    turnResponse += chunk;
                    currentStreaming += chunk;
                    panel._panel.webview.postMessage({ 
                        command: 'updateChat', 
                        history: panel.chatHistory, 
                        streamingText: currentStreaming 
                    });
                }, controller.signal);

                finalResponse += turnResponse;

                const grepMatch = turnResponse.match(/<grep\b([^>]*?)(?:\/>|>([\s\S]*?)<\/grep>)/i);
                const sparqlMatch = turnResponse.match(/<(?:sparql|query_architecture)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:sparql|query_architecture)>)/i);
                const peekMatch = turnResponse.match(/<peek_files\b([^>]*?)(?:\/>|>([\s\S]*?)<\/peek_files>)/i);
                const readMatch = turnResponse.match(/<(?:read_full_file|read_file)\b[^>]*path=["']([^"']+)["'][^>]*\/?>/i);
                const symMatch = turnResponse.match(/<(?:show_symbol|get_symbol_code|read_symbol)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:show_symbol|get_symbol_code|read_symbol)>)/i);
                const lollmsToolMatch = turnResponse.match(/<lollms_tool\b([^>]*?)>([\s\S]*?)<\/lollms_tool>/i) || turnResponse.match(/<lollms_tool\s+([^>]*?)\s*\/>/i);

                let toolExecuted = false;
                let toolName = "";
                let toolOutput = "";

                if (grepMatch) {
                    const attrStr = grepMatch[1] || "";
                    const pMatch = attrStr.match(/(?:pattern|query)=["']([^"']+)["']/i);
                    const pattern = pMatch ? pMatch[1] : (grepMatch[2] || "").trim();
                    const pathSubMatch = attrStr.match(/(?:path|include)=["']([^"']+)["']/i);
                    const subPath = pathSubMatch ? pathSubMatch[1].trim() : undefined;

                    if (pattern) {
                        toolExecuted = true;
                        toolName = `Grep: "${pattern}"`;
                        const searchRes = await this.contextManager.searchWorkspaceContent(
                            pattern,
                            { matchCase: false, wholeWord: false, include: subPath, bypassGate: true },
                            controller.signal
                        );
                        toolOutput = searchRes.length > 0
                            ? searchRes.slice(0, 15).map(r => `${r.path}:${r.line} - ${r.snippet}`).join('\n')
                            : "No matches found in workspace.";
                    }
                } else if (sparqlMatch) {
                    const attrStr = sparqlMatch[1] || "";
                    const qMatch = attrStr.match(/query=["']([\s\S]*?)["']/i);
                    const query = qMatch ? qMatch[1] : (sparqlMatch[2] || "").trim();

                    if (query) {
                        toolExecuted = true;
                        toolName = "SPARQL Architecture Query";
                        const graphManager = (this.contextManager as any).codeGraphManager;
                        if (graphManager) {
                            toolOutput = await graphManager.executeSparql(query);
                        } else {
                            toolOutput = "Code Graph Manager is not available.";
                        }
                    }
                } else if (peekMatch) {
                    const attrStr = peekMatch[1] || "";
                    const pMatch = attrStr.match(/path=["']([^"']+)["']/i);
                    const linesMatch = attrStr.match(/lines=["']?(\d+)["']?/i);
                    const p = pMatch ? pMatch[1] : (peekMatch[2] || "").trim().split(/\s+/)[0];
                    const lines = linesMatch ? parseInt(linesMatch[1], 10) : 30;

                    if (p) {
                        toolExecuted = true;
                        toolName = `Peek: ${p}`;
                        const peekRes = await this.contextManager.peekFiles([{ path: p, lines }]);
                        toolOutput = peekRes.map(r => r.error ? `Error: ${r.error}` : r.content).join('\n') || "Empty file.";
                    }
                } else if (readMatch) {
                    const reqPath = readMatch[1].trim();
                    toolExecuted = true;
                    toolName = `Read File: ${reqPath}`;
                    const res = await this.contextManager.resolveWorkspaceFromPath(reqPath);
                    if (res) {
                        try {
                            const bytes = await vscode.workspace.fs.readFile(res.uri);
                            toolOutput = Buffer.from(bytes).toString('utf8');
                            if (toolOutput.length > 30000) {
                                toolOutput = toolOutput.substring(0, 30000) + "\n... [truncated at 30k chars]";
                            }
                        } catch (e: any) {
                            toolOutput = `Error reading file: ${e.message}`;
                        }
                    } else {
                        toolOutput = `Could not resolve path "${reqPath}" on disk.`;
                    }
                } else if (symMatch) {
                    const attrStr = symMatch[1] || "";
                    const targetMatch = attrStr.match(/target=["']([^"']+)["']/i);
                    const pathMatch = attrStr.match(/path=["']([^"']+)["']/i);
                    const symParam = attrStr.match(/symbol=["']([^"']+)["']/i);
                    const rawTarget = targetMatch ? targetMatch[1].trim() : (pathMatch ? pathMatch[1].trim() : (symMatch[2] || "").trim());
                    const rawSym = symParam ? symParam[1].trim() : "";

                    const { showSymbolTool } = require('./tools/builtins/showSymbol');
                    const toolRes = await showSymbolTool.execute(
                        { target: rawTarget, symbol: rawSym },
                        { contextManager: this.contextManager, lollmsApi: this.lollmsAPI, workspaceRoot: vscode.workspace.workspaceFolders?.[0], currentPlan: null },
                        controller.signal
                    );
                    toolExecuted = true;
                    toolName = `Symbol: ${rawTarget}${rawSym ? `:${rawSym}` : ''}`;
                    toolOutput = toolRes.output;
                } else if (lollmsToolMatch) {
                    try {
                        const rawJson = lollmsToolMatch[2] ? lollmsToolMatch[2].trim() : lollmsToolMatch[1].trim();
                        let parsedCall: any = {};
                        try {
                            parsedCall = JSON.parse(rawJson);
                        } catch {
                            const repaired = rawJson.replace(/\\`/g, '`').replace(/[\r\n\t]/g, ' ').replace(/,\s*([\]}])/g, '$1');
                            parsedCall = JSON.parse(repaired);
                        }
                        const tName = parsedCall.name || "unknown_tool";
                        const tArgs = parsedCall.arguments || parsedCall.params || {};

                        const toolDef = this.contextManager?.agentManager?.getTools()?.find((t: any) => t.name === tName) ||
                                        (this.contextManager as any)?.toolManager?.getTool(tName);

                        if (toolDef) {
                            toolExecuted = true;
                            toolName = `Tool: ${tName}`;
                            const env: ToolExecutionEnv = {
                                workspaceRoot: vscode.workspace.workspaceFolders?.[0],
                                lollmsApi: this.lollmsAPI,
                                contextManager: this.contextManager,
                                currentPlan: null,
                                agentManager: this.contextManager?.agentManager
                            };
                            const res = await toolDef.execute(tArgs, env, controller.signal);
                            toolOutput = res.output;
                        }
                    } catch (e: any) {
                        toolExecuted = true;
                        toolName = "Tool Execution Error";
                        toolOutput = `Error parsing tool call: ${e.message}`;
                    }
                }

                if (toolExecuted) {
                    const blockHtml = `\n\n<details class="processing-block"><summary><i class="codicon codicon-tools"></i> <strong>${toolName}</strong></summary><div class="processing-body"><pre style="margin:0; max-height:160px; overflow:auto;">${toolOutput}</pre></div></details>\n\n`;
                    currentStreaming += blockHtml;
                    panel._panel.webview.postMessage({ 
                        command: 'updateChat', 
                        history: panel.chatHistory, 
                        streamingText: currentStreaming 
                    });

                    messages.push({ role: 'assistant', content: turnResponse });
                    messages.push({ 
                        role: 'user', 
                        content: `### 🛠️ TOOL OBSERVATION (${toolName}):\n\`\`\`\n${toolOutput}\n\`\`\`\n\nNow continue your technical answer, focusing on the current file (\`${relativePath}\`).` 
                    });
                } else {
                    break;
                }
            }

            const { content: cleanedResponse, memory = null } = extractAndStripMemory(stripThinkingTags(finalResponse));
            if (memory) {
                await this.memoryManager.updateMemory(memory);
            }

            panel.chatHistory.push({ role: 'assistant', content: finalResponse });
            panel._panel.webview.postMessage({ command: 'updateChat', history: panel.chatHistory, streamingText: "" });
            panel.addHistory(instruction, finalResponse); 

        } catch (error: any) {
            panel.setLoading(false);

            const isConnRefused = error.code === 'ECONNREFUSED' || 
                                  error.message?.includes('ECONNREFUSED') || 
                                  error.message?.includes('Failed to fetch') ||
                                  error.message?.includes('connect ECONNREFUSED');

            const resolved = this.lollmsAPI.resolveBindingForModel();
            const serverUrl = resolved?.binding?.apiUrl || 'http://127.0.0.1:9642';

            let errorMarkdown = "";
            if (isConnRefused) {
                errorMarkdown = `### 🔌 Connection Error (Server Offline)\n` +
                    `Could not connect to the AI server at \`${serverUrl}\`.\n\n` +
                    `**Reason**: \`${error.message}\`\n\n` +
                    `**Suggestions to resolve:**\n` +
                    `- Ensure your backend server (LoLLMs, Ollama, vLLM, etc.) is started and listening on \`${serverUrl}\`.\n` +
                    `- Verify the API host URL in **VS Code Settings** (\`lollmsVsCoder.apiUrl\` or Server Bindings).\n` +
                    `- Once the server is running, you can click **Retry** below to resend your request.`;
            } else {
                errorMarkdown = `### ⚠️ Request Error\n` +
                    `Lollms Companion encountered an error while communicating with the model:\n\n` +
                    `\`${error.message}\``;
            }

            panel.chatHistory.push({ role: 'assistant', content: errorMarkdown });
            panel._panel.webview.postMessage({ command: 'updateChat', history: panel.chatHistory, streamingText: "" });

            vscode.window.showErrorMessage(`Lollms Companion: Server offline or unreachable (${serverUrl})`);
        } finally {
            panel.setLoading(false);
        }
    }
}
