import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

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
    // Updated: added 'no_think' to allow disabling thinking via discussion capability
    thinkingMode: 'none' | 'chain_of_thought' | 'chain_of_verification' | 'plan_and_solve' | 'self_critique' | 'no_think';
    // NEW
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


export function getProcessedSystemPrompt(promptType: 'chat' | 'agent' | 'inspector' | 'commit', capabilities?: DiscussionCapabilities): string {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const reasoningLevel = config.get<string>('reasoningLevel') || 'none';
    
    // Prefer capability setting, fall back to global config (excluding no_think check which is now capability only)
    const thinkingMode = capabilities?.thinkingMode || config.get<string>('thinkingMode') || 'none';
    const developerName = config.get<string>('developerName') || 'Developer';

    let thinkingInstructions = '';

    // Handle Thinking Mode
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

            // Changed: Removed fallback to config 'fileUpdateMethod', default to 'full' if no capability provided
            const codeGenType = capabilities ? capabilities.codeGenType : 'full';
            
            if (codeGenType === 'full') {
                updateInstructions = fullFileInstruction;
            } else if (codeGenType === 'diff') {
                updateInstructions = diffInstruction;
            }
            
            let otherFileActions = '';
            
            if (!capabilities || capabilities.fileRename) {
                otherFileActions += `- **Rename/Move:** \`\`\`rename\nold1 -> new1\nold2 -> new2\n\`\`\` (Support multiple per block)\n`;
            }
            if (!capabilities || capabilities.fileDelete) {
                otherFileActions += `- **Delete:** \`\`\`delete\npath/to/file1\npath/to/file2\n\`\`\` (Support multiple per block)\n`;
            }
            if (!capabilities || capabilities.fileSelect) {
                otherFileActions += `- **Select Files (Add to Context):** \`\`\`select\npath/to/file1\npath/to/file2\n\`\`\`\n`;
            }
            if (!capabilities || capabilities.fileReset) {
                otherFileActions += `- **Reset Files (Clear Context):** \`\`\`context_reset\ntrue\n\`\`\`\n`;
            }

            // Git Commit Tool
            if (capabilities?.gitCommit) {
                otherFileActions += `- **Git Commit:** \`\`\`git_commit\nCommit message\n\`\`\` (Stages all changes and commits)\n`;
            }

            if (otherFileActions) {
                updateInstructions += `\n**OTHER FILE ACTIONS:**\n${otherFileActions}`;
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
        case 'inspector':
        case 'commit':
            personaKey = `${promptType}Persona`;
            break;
    }

    let userPersona = config.get<string>(personaKey) || '';
    
    if (capabilities?.funMode) {
        userPersona += "\n\n**FUN MODE ACTIVATED:** Be quirky, humorous, and use plenty of emojis! 🤪 Make coding fun!";
    }

    let combinedPrompt = `${thinkingInstructions}${basePrompt}\n\n**YOUR PERSONA:**\n${userPersona}`;

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    const platform = os.platform();
    
    let processedPrompt = combinedPrompt
        .replace(/{{date}}/g, date)
        .replace(/{{time}}/g, time)
        .replace(/{{datetime}}/g, `${date} ${time}`)
        .replace(/{{os}}/g, platform)
        .replace(/{{developer_name}}/g, developerName);

    let finalPrompt = processedPrompt.trim();

    // Changed: noThinkMode is now handled via thinkingMode capability
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

