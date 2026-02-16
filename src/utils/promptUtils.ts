import * as vscode from 'vscode';
import * as path from 'path';
import { ContextManager } from '../contextManager';
import { PromptBuilderPanel, parsePlaceholders } from '../commands/promptBuilderPanel';
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
    useContext: boolean = false
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
        const contextResult = await contextManager.getContextContent();
        if (contextResult && contextResult.text && !contextResult.text.includes("**No workspace folder is currently open.**")) {
            contextText = `\n\n==== PROJECT CONTEXT ====\n${contextResult.text}\n=========================\n`;
        }
    }

    let userPrompt = `I am working on the file \`${fileName}\` which is a \`${languageId}\` file.\n\nHere is the code selection:\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\nINSTRUCTION: **${userInstruction}**${contextText}`;

    let systemPrompt = '';

    if (actionType === 'information') {
        const agentPersonaPrompt = await getProcessedSystemPrompt('agent');
        userPrompt += `\n\nPlease provide a detailed answer in Markdown format.`;
        systemPrompt = `You are an expert code analyst. Your task is to answer questions and provide explanations about a given code snippet.
- Analyze the user's instruction and the provided code.
- Respond with a clear, well-formatted Markdown explanation.
- If you include code examples, use appropriate markdown code blocks.

User preferences: ${agentPersonaPrompt}`;
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
- NEVER use markdown code fences (like \` \` \` or \` \` \`${languageId}).
- NEVER include explanations, chatter, or "Here is your code".
- Provide the full replacement for the selected block only.
- Use relative indentation: the first line of your output should have NO leading whitespace (unless the line itself is empty). Subsequent lines should be indented relative to the first line.
- If you fail to follow these rules, the system will crash.`;

        systemPrompt = `You are a surgical code replacement engine. You output raw source code with NO formatting, NO markdown, and NO dialogue.`;
    }
    
    return { systemPrompt, userPrompt };
}
