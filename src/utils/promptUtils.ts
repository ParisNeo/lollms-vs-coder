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

    const agentPersonaPrompt = await getProcessedSystemPrompt('agent');
    let systemPrompt = '';

    if (actionType === 'information') {
        userPrompt += `\n\nPlease provide a detailed answer in Markdown format.`;
        systemPrompt = `You are an expert code analyst. Your task is to answer questions and provide explanations about a given code snippet.
- Analyze the user's instruction and the provided code.
- Respond with a clear, well-formatted Markdown explanation.
- If you include code examples, use appropriate markdown code blocks.

User preferences: ${agentPersonaPrompt}`;
    } else { 
        // Code Generation
        const startLine = Math.max(0, selection.start.line - 10);
        const endLine = Math.min(document.lineCount - 1, selection.end.line + 10);
        const beforeRange = new vscode.Range(new vscode.Position(startLine, 0), selection.start);
        const afterRange = new vscode.Range(selection.end, new vscode.Position(endLine, document.lineAt(endLine).text.length));
        const codeBefore = document.getText(beforeRange);
        const codeAfter = document.getText(afterRange);
        
        userPrompt = `I am working on the file \`${fileName}\` which is a \`${languageId}\` file.\n\n`;

        if (codeBefore.trim()) {
            userPrompt += `==== CONTEXT BEFORE (DO NOT INCLUDE IN OUTPUT) ====\n\`\`\`${languageId}\n${codeBefore}\n\`\`\`\n\n`;
        }
        userPrompt += `==== SELECTED CODE TO MODIFY (MODIFY THIS ONLY) ====\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n`;
        if (codeAfter.trim()) {
            userPrompt += `==== CONTEXT AFTER (DO NOT INCLUDE IN OUTPUT) ====\n\`\`\`${languageId}\n${codeAfter}\n\`\`\`\n\n`;
        }

        userPrompt += `INSTRUCTION: **${userInstruction}**\n${contextText}\n\n`;
        userPrompt += `⚠️ CRITICAL: Your response must contain ONLY the modified selected code block. Do not include any BEFORE or AFTER context code in your response.`;

        systemPrompt = `You are a surgical code modification tool. You must modify ONLY the selected code block and return ONLY that modified block.

## STRICT OUTPUT RULES
- Return ONLY the modified selected code in a single markdown code block
- NEVER include BEFORE context code in your response
- NEVER include AFTER context code in your response
- NEVER add explanations, comments, or text outside the code block
- The first line of your response must be the opening code fence: \`\`\`${languageId}
- The last line of your response must be the closing code fence: \`\`\`
- Do NOT use placeholder comments like "// rest of code"

Your entire response must be executable code that can directly replace the selected text.

User preferences: ${agentPersonaPrompt}`;
    }
    
    return { systemPrompt, userPrompt };
}
