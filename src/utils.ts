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
                instructionText = "Before providing your final answer, you must engage in a step-by-step thinking process. Outline your reasoning, the steps you'll take, and any assumptions you're making.";
                break;
            case 'chain_of_verification':
                instructionText = "Implement a Chain of Verification process:\n1. Generate a preliminary response (internal thought).\n2. Create a list of verification questions to check the facts and logic in your preliminary response.\n3. Answer these questions independently to verify the information.\n4. Specify any corrections needed.\n5. Generate the final, verified response.";
                break;
            case 'plan_and_solve':
                instructionText = "First, create a high-level plan to solve the user's request. Then, execute the plan. This helps in structuring your response for complex tasks.";
                break;
            case 'self_critique':
                instructionText = "After generating your initial response, you must stop and critically review it. Look for errors, logical flaws, or better alternative solutions. Explain your critique and provide the refined, final answer.";
                break;
            case 'custom':
                instructionText = config.get<string>('thinkingModeCustomPrompt') || '';
                break;
        }
        if (instructionText) {
            thinkingInstructions = `**THINKING PROCESS INSTRUCTIONS:**\nYou are required to use the following thinking process: ${instructionText} Enclose your entire thinking process, reasoning, and self-correction within a \`<thinking>\` XML block. This block will be hidden from the user but is crucial for your quality.\n\n`;
        }
    }

    let basePrompt = '';
    let personaKey = '';

    switch (promptType) {
        case 'chat': {
            let updateInstructions = '';

            const fullFileInstruction = `**FULL FILE MODE (ENABLED):**
To create or overwrite a file, use EXACTLY this format:
File: path/to/the/file.ext
\`\`\`language
// Full file content here
\`\`\`
**IMPORTANT:** Do NOT use diffs, patches, or git diff format. Output the **entire** file content.
`;

            const diffInstruction = `**DIFF MODE (ENABLED):**
To patch a file, use:
Diff: path/to/the/file.ext
\`\`\`diff
@@ -1,1 +1,1 @@
- old
+ new
\`\`\`
`;

            const insertInstruction = `**INSERT MODE (ENABLED):**
To insert code into a file at a specific location, use:
Insert: path/to/the/file.ext
\`\`\`insertion
<<<<
context line(s) to locate the insertion point
====
code to insert after the context
>>>>
\`\`\`
The code will be inserted immediately AFTER the context lines.
`;

            const replaceInstruction = `**REPLACE MODE (ENABLED):**
To replace a specific block of code, use:
Replace: path/to/the/file.ext
\`\`\`replacement
<<<<
original code to be replaced
====
new code to replace it with
>>>>
\`\`\`
`;

            const deleteInstruction = `**DELETE CODE MODE (ENABLED):**
To delete a specific block of code, use:
DeleteCode: path/to/the/file.ext
\`\`\`deletion
<<<<
code to be deleted
>>>>
\`\`\`
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
                otherFileActions += `- **Rename/Move:** \`\`\`rename\nold1 -> new1\nold2 -> new2\n\`\`\` (Support multiple per block)\n`;
            }
            if (!capabilities || capabilities.fileDelete) {
                otherFileActions += `- **Delete File:** \`\`\`delete\npath/to/file1\npath/to/file2\n\`\`\` (Support multiple per block)\n`;
            }
            if (!capabilities || capabilities.fileSelect) {
                otherFileActions += `- **Select Files (Add to Context):** \`\`\`select\npath/to/file1\npath/to/file2\n\`\`\`\n`;
            }
            if (!capabilities || capabilities.fileReset) {
                otherFileActions += `- **Reset Files (Clear Context):** \`\`\`context_reset\ntrue\n\`\`\`\n`;
            }

            if (capabilities?.gitCommit) {
                otherFileActions += `- **Git Commit:** \`\`\`git_commit\nCommit message\n\`\`\` (Stages all changes and commits)\n`;
            }

            if (otherFileActions) {
                updateInstructions += `\n**OTHER ACTIONS:**\n${otherFileActions}`;
            }

            const enableImageGen = capabilities ? capabilities.imageGen : true;
            if (enableImageGen) {
                updateInstructions += `
**IMAGE GENERATION:**
To generate an image, use:
File: path/to/save/image.png
\`\`\`image_prompt
Detailed prompt...
\`\`\`
If you provide a File path, it will be saved there. If not, the user will be asked where to save it.
`;
            }

            if (capabilities?.webSearch) {
                updateInstructions += `
**WEB SEARCH:**
To search the web, use:
\`\`\`search_web
search query here
\`\`\`
`;
            }

            if (capabilities?.arxivSearch) {
                updateInstructions += `
**ARXIV SEARCH:**
To search Arxiv, use:
\`\`\`search_arxiv
search query here
\`\`\`
`;
            }
            basePrompt = `You are a VSCode Assistant. Your goal is to assist with code, debugging, and project tasks.

**MANDATORY OUTPUT FORMATS:**
${updateInstructions}

**GENERAL CHAT:** No actions? Respond in clean Markdown.

**ABSOLUTE RULE:** Formats are sacred. Any deviation breaks the parser.`;
            personaKey = 'chatPersona';
            break;
        }
        case 'agent':
            // Overwrite agent prompt to be more specific about observation
            basePrompt = `You are a meticulous, autonomous AI Agent. You break down complex goals into tools and steps.
**CRITICAL RULES:**
1. **OBSERVE FIRST:** Before deciding a task failed, read the tool output CAREFULLY. If looking for a name or IP, check every line. Do not hallucinate failures if the data is present.
2. **NO LOOPS:** If a strategy fails, do NOT repeat it exactly. Try a different approach. Check the scratchpad for past failures.
3. **BACKUPS:** Before destructive actions, use the git tools to stage changes.
4. **DEPENDENCIES:** When writing code, ALWAYS verify imports exist. Do not assume.`;
            personaKey = 'agentPersona';
            break;
        case 'inspector':
            personaKey = `${promptType}Persona`;
            break;
        case 'commit':
            basePrompt = `**IDENTITY:** You are an expert developer writing git commit messages.
**TASK:** Generate a concise, standardized git commit message based on the provided code changes.
**FORMAT:** Follow the Conventional Commits specification:
\`type(scope): subject\`

\`body\`

**MANDATORY OUTPUT:**
- You MUST wrap the commit message in a code block (\`\`\`).
- Do NOT include any introductory text like "Here is the commit message".
- Do NOT include any closing text.
- The output should contain *only* the code block.

**Example Output:**
\`\`\`
feat(auth): add JWT-based authentication

- Implement login endpoint
- Add token verification middleware
\`\`\`
`;
            personaKey = `${promptType}Persona`;
            break;
    }

    let userPersona = '';
    
    if (customPersonaContent) {
        userPersona = customPersonaContent;
    } else {
        userPersona = config.get<string>(personaKey) || '';
    }
    
    if (capabilities?.funMode) {
        userPersona += "\n\n**FUN MODE ACTIVATED:** Be quirky, humorous, and use plenty of emojis! 🤪 Make coding fun!";
    }

    // --- User Info & Memory Injection ---
    let userInfoBlock = `
**USER CONTEXT:**
- Name: ${userName}
- Email: ${userEmail}
- Preferred License: ${userLicense}
- Coding Style: ${userStyle}

**INSTRUCTIONS ON USER CONTEXT:**
1. Use the provided Name and Email when generating file headers, comments, or documentation that requires authorship.
2. Use the Preferred License when generating new files that require a license header.
3. Adhere to the Coding Style preferences provided.
`;

    let memoryBlock = "";
    if (memoryContent.trim()) {
        memoryBlock = `
**LONG-TERM MEMORY:**
The following is information you have learned about the user or project from previous interactions:
\`\`\`
${memoryContent}
\`\`\`

**MEMORY MANAGEMENT:**
If you learn something new and important about the user (preferences, specific project details, tech stack constraints), you can update this memory.
To update memory, include a block at the end of your response like this:
<memory>
[Rewritten full memory content merging old and new info]
</memory>
This tag will be hidden from the user but saved to the system. Keep memory concise and relevant.
`;
    } else {
        memoryBlock = `
**MEMORY MANAGEMENT:**
You have a memory system. If you learn something important about the user (e.g., they hate semicolons, they work in React), store it.
To store memory, include a block at the end of your response:
<memory>
User prefers [preference]...
</memory>
`;
    }

    let combinedPrompt = `${thinkingInstructions}${basePrompt}\n${userInfoBlock}\n${memoryBlock}\n\n**YOUR PERSONA:**\n${userPersona}`;
    
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    const platform = os.platform();
    
    let processedPrompt = combinedPrompt
        .replace(/{{date}}/g, date)
        .replace(/{{time}}/g, time)
        .replace(/{{datetime}}/g, `${date} ${time}`)
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
