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

    if (useContext) {
        // --- UPGRADE: MINIMAL INITIAL CONTEXT ---
        const tree = await contextManager.getContextStateProvider()?.getAllVisibleFiles();
        const skills = await contextManager.skillsManager?.getSkills();
        const topCategories = Array.from(new Set(skills?.map(s => s.category?.split('/')[0]).filter(Boolean)));

        contextText = `\n\n### PROJECT STRUCTURE:\n${tree?.join('\n')}\n\n### AVAILABLE SKILL CATEGORIES:\n${topCategories.join(', ')}\n`;
        
        // Include current file content as essential minimal context
        const currentFileText = document.getText();
        const relPath = vscode.workspace.asRelativePath(document.uri);
        contextText += `\n### CURRENT FILE: ${relPath}\n\`\`\`${languageId}\n${currentFileText}\n\`\`\`\n`;
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
