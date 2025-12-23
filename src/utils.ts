import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { MemoryManager } from './memoryManager';

export interface DiscussionCapabilities {
    codeGenType: 'full' | 'diff' | 'none';
    fileRename: boolean;
    fileDelete: boolean;
    fileSelect: boolean;
    fileReset: boolean;
    imageGen: boolean;
    webSearch: boolean;
    arxivSearch: boolean;
    funMode: boolean;
    thinkingMode: 'none' | 'chain_of_thought' | 'chain_of_verification' | 'plan_and_solve' | 'self_critique' | 'no_think';
    gitCommit: boolean;
}

export async function applyDiff(diffContent: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        throw new Error('No workspace folder open.');
    }
    const workspaceRoot = workspaceFolders[0].uri;

    const fileMatch = diffContent.match(/^(?:--- a\/|\+\+\+ b\/)(.*)$/m);
    if (!fileMatch) {
        throw new Error('Could not determine file path from diff.');
    }
    const relativePath = fileMatch[1].trim();
    const fileUri = vscode.Uri.joinPath(workspaceRoot, relativePath);

    let document;
    try {
        document = await vscode.workspace.openTextDocument(fileUri);
    } catch (error) {
        throw new Error(`File not found: ${relativePath}`);
    }

    const originalLines = document.getText().split('\n');
    const diffLines = diffContent.split('\n');
    const edit = new vscode.WorkspaceEdit();

    let originalLineIndex = -1;

    for (const line of diffLines) {
        if (line.startsWith('@@')) {
            const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunkMatch) {
                originalLineIndex = parseInt(hunkMatch[1], 10) - 1;
            }
        } else if (line.startsWith('-')) {
            if (originalLineIndex >= 0) {
                const range = new vscode.Range(new vscode.Position(originalLineIndex, 0), new vscode.Position(originalLineIndex + 1, 0));
                if (originalLines[originalLineIndex].trimEnd() === line.substring(1).trimEnd()) {
                    edit.delete(fileUri, range);
                    originalLineIndex++;
                }
            }
        } else if (line.startsWith('+')) {
            if (originalLineIndex >= 0) {
                edit.insert(fileUri, new vscode.Position(originalLineIndex, 0), line.substring(1) + '\n');
            }
        } else if (line.startsWith(' ')) {
            if(originalLineIndex >= 0) {
                originalLineIndex++;
            }
        }
    }

    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
        throw new Error('VS Code failed to apply edits.');
    }
    await document.save();
}

export async function getProcessedSystemPrompt(
    promptType: 'chat' | 'agent' | 'inspector' | 'commit', 
    capabilities?: DiscussionCapabilities,
    customPersonaContent?: string,
    memoryManager?: MemoryManager
): Promise<string> {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const reasoningLevel = config.get<string>('reasoningLevel') || 'none';
    const thinkingMode = capabilities?.thinkingMode || config.get<string>('thinkingMode') || 'none';
    
    // User Info
    const userName = config.get<string>('userInfo.name') || 'Developer';
    const userEmail = config.get<string>('userInfo.email') || '';
    const userLicense = config.get<string>('userInfo.license') || 'MIT';
    const userStyle = config.get<string>('userInfo.codingStyle') || '';

    let memoryContent = "";
    if (memoryManager) {
        memoryContent = await memoryManager.getMemory();
    }

    let thinkingInstructions = '';

    if (thinkingMode !== 'none' && thinkingMode !== 'no_think') {
        let instructionText = '';
        switch (thinkingMode) {
            case 'chain_of_thought':
                instructionText = "Before providing your final answer, you must engage in a deep step-by-step thinking process. Break down the user's request, evaluate implementation strategies, and identify potential conflicts or improvements before writing any code.";
                break;
            case 'chain_of_verification':
                instructionText = "Implement a Chain of Verification: 1. Generate a preliminary response (internal thought). 2. Identify claims or code logic that need verification. 3. Verify these against project context and facts. 4. Generate the final, verified response.";
                break;
            case 'plan_and_solve':
                instructionText = "First, create a high-level plan to solve the user's request. Review the plan for efficiency. Then, execute the plan using the provided code blocks.";
                break;
            case 'self_critique':
                instructionText = "After generating your initial response, stop and critically review it for logic flaws, security vulnerabilities, or bugs. Output the final, refined answer after this critique.";
                break;
            case 'custom':
                instructionText = config.get<string>('thinkingModeCustomPrompt') || '';
                break;
        }
        if (instructionText) {
            thinkingInstructions = `**ADVANCED REASONING PROTOCOL:**\nYou are required to use the following thinking process: ${instructionText} Enclose your entire thinking process, reasoning, and self-correction within a \`<thinking>\` XML block. This block will be hidden from the user but is crucial for your quality control.\n\n`;
        }
    }

    let basePrompt = '';
    let personaKey = '';

    switch (promptType) {
        case 'chat': {
            let updateInstructions = '';

            const fullFileInstruction = `**FULL FILE MODE (SACRED FORMAT):**
To create or overwrite a file, use EXACTLY this format:
File: path/to/the/file.ext
\`\`\`language
// Full, complete file content here. NO PLACEHOLDERS.
\`\`\`
**IMPORTANT:** The 'File:' line must be plain text. Do NOT wrap it in a code block.
`;

            const diffInstruction = `**DIFF MODE (SACRED FORMAT):**
To patch a file, use:
Diff: path/to/the/file.ext
\`\`\`diff
@@ -1,1 +1,1 @@
- old
+ new
\`\`\`
**IMPORTANT:** The 'Diff:' line must be plain text. Do NOT wrap it in a code block.
`;

            const insertInstruction = `**INSERT MODE (SACRED FORMAT):**
Insert: path/to/the/file.ext
\`\`\`insertion
<<<<
context line(s) to locate the point
====
code to insert after context
>>>>
\`\`\`
**IMPORTANT:** The 'Insert:' line must be plain text. Do NOT wrap it in a code block.
`;

            const replaceInstruction = `**REPLACE MODE (SACRED FORMAT):**
Replace: path/to/the/file.ext
\`\`\`replacement
<<<<
original code to be replaced
====
new code to replace it with
>>>>
\`\`\`
**IMPORTANT:** The 'Replace:' line must be plain text. Do NOT wrap it in a code block.
`;

            const deleteInstruction = `**DELETE CODE MODE (SACRED FORMAT):**
DeleteCode: path/to/the/file.ext
\`\`\`deletion
<<<<
code to be deleted
>>>>
\`\`\`
**IMPORTANT:** The 'DeleteCode:' line must be plain text. Do NOT wrap it in a code block.
`;

            const codeGenType = capabilities ? capabilities.codeGenType : 'full';
            
            if (codeGenType === 'full') {
                updateInstructions = fullFileInstruction;
            } else if (codeGenType === 'diff') {
                updateInstructions = diffInstruction;
            }
            
            updateInstructions += `\n${insertInstruction}\n${replaceInstruction}\n${deleteInstruction}`;
            
            let otherFileActions = '';
            
            if (!capabilities || capabilities.fileRename) {
                otherFileActions += `- **Rename/Move:** \`\`\`rename\nold -> new\n\`\`\`\n`;
            }
            if (!capabilities || capabilities.fileDelete) {
                otherFileActions += `- **Delete File:** \`\`\`delete\npath/to/file\n\`\`\`\n`;
            }
            if (!capabilities || capabilities.fileSelect) {
                otherFileActions += `- **Select Files (Add to Context):** \`\`\`select\npath/to/file\n\`\`\`\n`;
            }

            if (otherFileActions) {
                updateInstructions += `\n**OTHER ACTIONS:**\n${otherFileActions}`;
            }

            const searchInstruction = capabilities?.webSearch ? `
**AUTOMATED WEB SEARCH TAG:**
If you need current information, documentation, or search results to answer accurately, you can trigger a search by outputting:
<web_search>your search query</web_search>
The extension will stop your generation, fetch results, append them to context, and ask you to continue.
` : '';

            basePrompt = `You are a Senior VSCode Engineering Assistant. 

**CRITICAL MANDATES:**
1. **DESCRIPTION FIRST:** Always start your response with a clear, pedagogical description of what you are about to do and why. Teach the developer. Never output code blocks alone.
2. **FORMATS ARE SACRED:** Use the exact formats provided below for file modifications. Deviation breaks the parser.
3. **NO CODE BLOCKS FOR PATHS:** Never wrap the "File:", "Insert:", "Replace:", "Diff:", or "DeleteCode:" lines in markdown code blocks. They must be plain text.

${updateInstructions}
${searchInstruction}

**ABSOLUTE RULE:** Be descriptive, helpful, and concise. Help the user understand the architecture, not just the fix.`;
            personaKey = 'chatPersona';
            break;
        }
        case 'agent':
            basePrompt = `You are a meticulous, autonomous AI Agent. Observe first. Check tool outputs. Do not assume success if an error message is returned.`;
            personaKey = 'agentPersona';
            break;
        case 'inspector':
            personaKey = `codeInspectorPersona`;
            break;
        case 'commit':
            basePrompt = `You are an expert dev. Write conventional git commit messages. Output ONLY the code block. No chatter.`;
            personaKey = `commitMessagePersona`;
            break;
    }

    let userPersona = customPersonaContent || config.get<string>(personaKey) || '';
    if (capabilities?.funMode) userPersona += "\n\n**FUN MODE ACTIVATED:** Be quirky, humorous, and use plenty of emojis! 🤪";

    let userInfoBlock = `\n**USER CONTEXT:**\n- Name: ${userName}\n- Email: ${userEmail}\n- Style: ${userStyle}`;
    let memoryBlock = memoryContent.trim() ? `\n**LONG-TERM MEMORY:**\n\`\`\`\n${memoryContent}\n\`\`\`\nUpdate memory using <memory>...</memory> tags if needed.` : "";

    let combinedPrompt = `${thinkingInstructions}${basePrompt}\n${userInfoBlock}\n${memoryBlock}\n\n**YOUR PERSONA:**\n${userPersona}`;
    
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const platform = os.platform();
    
    let processedPrompt = combinedPrompt
        .replace(/{{date}}/g, date)
        .replace(/{{os}}/g, platform)
        .replace(/{{developer_name}}/g, userName);

    let finalPrompt = processedPrompt.trim();

    if (thinkingMode === 'no_think') {
        finalPrompt = `/no_think\n${finalPrompt}`;
    } else if (reasoningLevel !== 'none') {
        finalPrompt = `/reasoning_${reasoningLevel}\n${finalPrompt}`;
    }

    return finalPrompt ? `${finalPrompt}\n\n` : '';
}

export function stripThinkingTags(responseText: string): string {
    const thinkRegex = /<(think|thinking)>[\s\S]*?<\/\1>/g;
    return responseText.replace(thinkRegex, '').trim();
}

export function extractAndStripMemory(responseText: string): { content: string, memory: string | null } {
    const memoryRegex = /<memory>([\s\S]*?)<\/memory>/;
    const match = responseText.match(memoryRegex);
    let memory = null;
    let content = responseText;

    if (match) {
        memory = match[1].trim();
        content = responseText.replace(memoryRegex, '').trim();
    }

    return { content, memory };
}
