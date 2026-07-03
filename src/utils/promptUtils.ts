import * as vscode from 'vscode';
import * as path from 'path';
import { ContextManager } from '../contextManager';
import { PromptBuilderPanel, parsePlaceholders } from '../commands/promptBuilderPanel';
import { ChatPanel } from '../commands/chatPanel/chatPanel';
import { getProcessedSystemPrompt } from '../utils';

/**
 * Helper to normalize search text to match the document's EOL convention.
 */
export function normalizeToDocument(searchString: string, document: vscode.TextDocument): string {
    const docEol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    return searchString.replace(/\r\n/g, '\n').replace(/\n/g, docEol);
}

export async function buildCodeActionPrompt(
    promptTemplate: string, 
    actionType: 'generation' | 'information' | undefined,
    editor: vscode.TextEditor | undefined, 
    extensionUri: vscode.Uri,
    contextManager: ContextManager,
    lollmsApi: any,
    useContext: boolean = false,
    signal?: AbortSignal
): Promise<{ systemPrompt: string, userPrompt: string } | null> {
    let processedTemplate = promptTemplate;
    const placeholders = parsePlaceholders(processedTemplate);
    if (placeholders.length > 0) {
        const formData = await PromptBuilderPanel.createOrShow(extensionUri, placeholders);
        if (formData === null) return null;
        placeholders.forEach(p => {
            const value = formData[p.name] ?? '';
            processedTemplate = processedTemplate.replace(p.fullMatch, String(value));
        });
    }

    const userInstruction = processedTemplate.replace('{{SELECTED_CODE}}', '').trim();
    
    let contextText = '';
    let contextResult: any = { text: '', images: [], projectTree: '', selectedFilesContent: '', skillsContent: '', importedSkills: [] };

    if (useContext) {
        // --- LEAN INITIAL CONTEXT ---
        // We only provide the file PATHS (tree), not the content.
        const tree = await contextManager.getContextStateProvider()?.getAllVisibleFiles();
        contextText = `\n\n### PROJECT STRUCTURE (PATHS ONLY):\n${tree?.join('\n')}\n`;
        
        const skills = await contextManager.skillsManager?.getSkills();
        if (skills && skills.length > 0) {
            const skillSummaries = skills.map(s => `- ${s.id}: ${s.description}`).join('\n');
            contextText += `\n### AVAILABLE SKILLS (IDs):\n${skillSummaries}\n`;
        }
    }

    let userPrompt = `**USER OBJECTIVE:** "${userInstruction}"\n${contextText}`;
    let systemPrompt = '';

    if (editor) {
        const selection = editor.selection;
        const document = editor.document;
        const selectedText = document.getText(selection);
        const languageId = document.languageId;
        const relPath = vscode.workspace.asRelativePath(document.uri);

        // --- INDENTATION DETECTION ---
        const tabSize = editor.options.tabSize as number || 4;
        const insertSpaces = editor.options.insertSpaces as boolean;
        const indentStyle = insertSpaces ? `${tabSize} spaces` : "Tabs";

        // --- GRAPH-GROUNDED CONTEXT ---
        const graph = contextManager['codeGraphManager'];
        let symbolContext = "";

        if (graph) {
            if (graph.getBuildState() !== 'ready') await graph.buildGraph();

            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider', 
                document.uri
            );

            const findEnclosingSymbol = (syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol | null => {
                for (const s of syms) {
                    if (s.range.contains(selection.start)) {
                        const child = findEnclosingSymbol(s.children);
                        return child || s;
                    }
                }
                return null;
            };

            const targetSymbol = findEnclosingSymbol(symbols || []);
            if (targetSymbol) {
                const containerCode = document.getText(targetSymbol.range);
                symbolContext = `#### 📦 ENCLOSING SYMBOL: ${targetSymbol.name}\n\`\`\`${languageId}\n${containerCode}\n\`\`\`\n\n`;

                const relations = graph.getArchitectureAnalysis(targetSymbol.name, 'dependencies');
                const usages = graph.getArchitectureAnalysis(targetSymbol.name, 'usages');
                symbolContext += `#### 🔗 ARCHITECTURAL RELATIONS\n${relations}\n${usages}\n\n`;
            }
        }

        if (!symbolContext) {
            const startLine = selection.start.line;
            const contextRange = new vscode.Range(
                new vscode.Position(Math.max(0, startLine - 15), 0),
                new vscode.Position(Math.min(document.lineCount - 1, selection.end.line + 15), 1000)
            );
            symbolContext = `#### 📍 SPATIAL CONTEXT\n\`\`\`${languageId}\n${document.getText(contextRange)}\n\`\`\`\n\n`;
        }

        userPrompt = `### 🎯 SURGICAL TARGET: ${relPath}\n` +
                     `**Language:** ${languageId}\n` +
                     `**Required Indentation:** ${indentStyle}\n\n` +
                     `**STRICT INDENTATION RULE**: Your SEARCH block must match the indentation of the code below exactly. ` +
                     `Your REPLACE block must use the exact same nesting level. Do not switch from spaces to tabs.\n\n` +
                     symbolContext +
                     `#### 🔍 EXACT SELECTION TO MODIFY\n` +
                     `\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n` +
                     `**USER OBJECTIVE:** "${userInstruction}"\n` +
                     `${contextText}`;

        const baseSystemPrompt = await getProcessedSystemPrompt('surgical_agent', undefined, undefined, undefined, false, contextResult);

        if (actionType === 'information') {
            userPrompt += `\n\nPlease provide a detailed answer in Markdown format.`;
            systemPrompt = `${baseSystemPrompt}\n\nYou are an expert code analyst. Your task is to answer questions and provide explanations about a given code snippet.
- Analyze the user's instruction and the provided code.
- Respond with a clear, well-formatted Markdown explanation.
- If you include code examples, use appropriate markdown code blocks.`;
        } else { 
            userPrompt = `I am working on a \`${languageId}\` file.
I want to modify the following code selection:
\`\`\`${languageId}
${selectedText}
\`\`\`

INSTRUCTION: **${userInstruction}**
${contextText}

TASK:
You must use the SEARCH/REPLACE block format to apply the requested changes. 
Only replace the code that needs to be changed.

\`\`\`${languageId}
<<<<<<< SEARCH
[Exact code to replace from the original file, including context lines]
=======
[New updated code]
>>>>>>> REPLACE
\`\`\`

### ⚠️ CRITICAL CONSTRAINTS:
- The SEARCH block MUST match the original file EXACTLY, including indentation.
- If you are only modifying a few lines inside a large selection, do NOT replace the whole selection. Create a focused SEARCH/REPLACE block for just the changed lines.
- NEVER include explanations, chatter, or "Here is your code". Output ONLY the SEARCH/REPLACE blocks (or tool calls if needed).`;
            
            systemPrompt = `${baseSystemPrompt}\n\nYou are a surgical code replacement engine. You strictly output SEARCH/REPLACE blocks with NO dialogue.`;
        }
    } else {
        const baseSystemPrompt = await getProcessedSystemPrompt('chat', undefined, undefined, undefined, false, contextResult);
        systemPrompt = `${baseSystemPrompt}\n\nYou are a helpful architectural assistant. Casual chat mode active. Provide a friendly and structured response.`;
    }
    
    return { systemPrompt, userPrompt };
}
