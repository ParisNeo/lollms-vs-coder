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
    editor: vscode.TextEditor, 
    extensionUri: vscode.Uri,
    contextManager: ContextManager,
    lollmsApi: any,
    useContext: boolean = false,
    signal?: AbortSignal
): Promise<{ systemPrompt: string, userPrompt: string } | null> {
    const selection = editor.selection;
    const document = editor.document;

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
    const selectedText = document.getText(selection);
    const fileName = path.basename(document.fileName);
    const languageId = document.languageId;
    
    let contextText = '';
    if (useContext) {
        const projectSkillIds = await contextManager.getActiveProjectSkills();
        const activeDiscussion = ChatPanel.currentPanel?.getCurrentDiscussion();
        const discussionSkillIds = activeDiscussion?.importedSkills || [];
        const activeDiagramIds = activeDiscussion?.activeDiagrams || [];
        const combinedSkillIds = Array.from(new Set([...projectSkillIds, ...discussionSkillIds]));

        // 1. Fetch "Warm" Context (Skills, Diagrams, and ALREADY included files from Auto Context)
        const contextResult = await contextManager.getContextContent({ 
            includeTree: true,
            importedSkillIds: combinedSkillIds,
            activeDiagramIds: activeDiagramIds,
            modelName: ChatPanel.currentPanel?.getCurrentDiscussion()?.model || lollmsApi.getModelName()
        });

        contextText = contextResult.text;

        // 2. SMART DEPENDENCY PEAK: If we have an API and a signal, find missing dependencies
        if (lollmsApi && !signal?.aborted) {
            try {
                const allFiles = await contextManager.getWorkspaceFilePaths();
                const currentIncluded = contextManager.getContextStateProvider()?.getIncludedFiles().map(f => f.path) || [];
                
                const selectionSystemPrompt = {
                    role: 'system',
                    content: `You are a dependency analyzer. The user is refactoring a code snippet in "${fileName}".
Identify which existing files in the project are crucial to read (types, base classes, or related logic) to avoid hallucinations.
- PRIORITIZE files in the "ALREADY INCLUDED" list.
- Select up to 5 additional relevant files.
- Return ONLY a valid JSON array of strings.`
                };

                const selectionUserPrompt = {
                    role: 'user',
                    content: `**Selection in ${fileName}:**\n\`\`\`\n${selectedText}\n\`\`\`\n\n**Included Files:** ${JSON.stringify(currentIncluded)}\n\n**All Files:**\n${allFiles.join('\n')}`
                };

                const response = await lollmsApi.sendChat([selectionSystemPrompt, selectionUserPrompt], null, signal);
                const jsonMatch = response.match(/\[.*\]/s);
                if (jsonMatch) {
                    const filesToPeek = JSON.parse(jsonMatch[0]).filter((f: string) => f !== relativePath);
                    const peekedContent = await contextManager.readSpecificFiles(filesToPeek);
                    if (peekedContent) {
                        contextText += `\n\n## RELATED DEPENDENCIES (PEEKED)\n${peekedContent}`;
                    }
                }
            } catch (e) {
                console.warn("Smart context peek failed, proceeding with base context.", e);
            }
        }

        if (contextText && !contextText.includes("**No workspace folder is currently open.**")) {
            let diagramText = "";
            if (contextResult.diagrams && contextResult.diagrams.length > 0) {
                diagramText = "\n## ARCHITECTURE DIAGRAMS\n" + contextResult.diagrams.map(d => 
                    `### ${d.type.toUpperCase()}\n\`\`\`mermaid\n${d.mermaid}\n\`\`\``
                ).join('\n\n');
            }
            contextText = `\n\n==== PROJECT & SMART CONTEXT ====\n${contextText}${diagramText}\n==================================\n`;
        }
    }

    let userPrompt = `I am working on the file \`${fileName}\` which is a \`${languageId}\` file.\n\nHere is the code selection:\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\nINSTRUCTION: **${userInstruction}**${contextText}`;

    let systemPrompt = '';

    // Fetch unified system prompt to include Skills and Environment
    const baseSystemPrompt = await getProcessedSystemPrompt('agent', undefined, undefined, undefined, false, contextResult);

    if (actionType === 'information') {
        userPrompt += `\n\nPlease provide a detailed answer in Markdown format.`;
        systemPrompt = `${baseSystemPrompt}\n\nYou are an expert code analyst. Your task is to answer questions and provide explanations about a given code snippet.
- Analyze the user's instruction and the provided code.
- Respond with a clear, well-formatted Markdown explanation.
- If you include code examples, use appropriate markdown code blocks.`;
    } else { 
        // Code Generation (Surgical Replacement)
        userPrompt = `I am working on a \`${languageId}\` file.
I have selected this specific block of code:
\`\`\`${languageId}
${selectedText}
\`\`\`

INSTRUCTION: **${userInstruction}**
${contextText}

TASK:
Provide the NEW version of the selected code block. 

### ⚠️ CRITICAL CONSTRAINTS:
- Output ONLY the raw source code.
- NEVER use markdown code fences.
- NEVER include explanations, chatter, or "Here is your code".
- NEVER use placeholders or ellipses. Provide the full logic for the target block.
- Provide the full replacement for the selected block only.
- Use relative indentation: the first line of your output should have NO leading whitespace. Subsequent lines should be indented relative to the first line.`;
        
        systemPrompt = `${baseSystemPrompt}\n\nYou are a surgical code replacement engine. You output raw source code with NO formatting, NO markdown, and NO dialogue.`;
    }
    
    return { systemPrompt, userPrompt };
}
