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
    let contextResult: any = { text: '', images: [], projectTree: '', selectedFilesContent: '', skillsContent: '', importedSkills: [] };

    const currentFileText = document.getText();
    const relPath = vscode.workspace.asRelativePath(document.uri);

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

    let userPrompt = `### CURRENT FILE: ${relPath}\n` +
                     `\`\`\`${languageId}\n${currentFileText}\n\`\`\`\n\n` +
                     `### SELECTED CODE (Lines ${selection.start.line + 1}-${selection.end.line + 1}):\n` +
                     `\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n` +
                     `**USER INSTRUCTION:** ${userInstruction}\n` +
                     `${contextText}`;

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
=======[New updated code]
>>>>>>> REPLACE
\`\`\`

### ⚠️ CRITICAL CONSTRAINTS:
- The SEARCH block MUST match the original file EXACTLY, including indentation.
- If you are only modifying a few lines inside a large selection, do NOT replace the whole selection. Create a focused SEARCH/REPLACE block for just the changed lines.
- NEVER include explanations, chatter, or "Here is your code". Output ONLY the SEARCH/REPLACE blocks (or tool calls if needed).`;
        
        systemPrompt = `${baseSystemPrompt}\n\nYou are a surgical code replacement engine. You strictly output SEARCH/REPLACE blocks with NO dialogue.`;
    }
    
    return { systemPrompt, userPrompt };
}
