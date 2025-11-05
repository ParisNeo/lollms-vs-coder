import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

export async function applyDiff(diffContent: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        throw new Error('No workspace folder open.');
    }
    const workspaceRoot = workspaceFolders[0].uri;

    // Basic parsing to find the file path from '--- a/path/to/file' or '+++ b/path/to/file'
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

    let originalLineIndex = -1; // -1 because hunk headers are 1-based

    for (const line of diffLines) {
        if (line.startsWith('@@')) {
            const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunkMatch) {
                originalLineIndex = parseInt(hunkMatch[1], 10) - 1;
            }
        } else if (line.startsWith('-')) {
            if (originalLineIndex >= 0) {
                const range = new vscode.Range(new vscode.Position(originalLineIndex, 0), new vscode.Position(originalLineIndex + 1, 0));
                // Verify the line matches before deleting
                if (originalLines[originalLineIndex].trimEnd() === line.substring(1).trimEnd()) {
                    edit.delete(fileUri, range);
                    originalLineIndex++;
                } else {
                   // Ignore if doesn't match, could be context mismatch
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
    // Save the document after applying changes
    await document.save();
}


export function getProcessedSystemPrompt(promptType: 'chat' | 'agent' | 'inspector' | 'commit'): string {
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const noThinkMode = config.get<boolean>('noThinkMode') || false;
    const reasoningLevel = config.get<string>('reasoningLevel') || 'none';
    const thinkingMode = config.get<string>('thinkingMode') || 'none';
    const developerName = config.get<string>('developerName') || 'Developer';

    let thinkingInstructions = '';

    if (!noThinkMode && thinkingMode !== 'none') {
        let instructionText = '';
        switch (thinkingMode) {
            case 'chain_of_thought':
                instructionText = "Before providing your final answer, you must engage in a step-by-step thinking process. Outline your reasoning, the steps you'll take, and any assumptions you're making.";
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
            thinkingInstructions = `**THINKING PROCESS INSTRUCTIONS:**\nYou are required to use the following thinking process: ${instructionText} Enclose your entire thinking process, reasoning, and self-correction within a \`<thinking>\` XML block. This block will be hidden from the user but is crucial for your process.\n\n`;
        }
    }

    let basePrompt = '';
    let personaKey = '';

    switch (promptType) {
        case 'chat': {
            const fileUpdateMethod = config.get<string>('fileUpdateMethod') || 'full_file';
            let updateInstructions = '';

            const fullFileInstruction = `To create or overwrite a file, you MUST use the following two-part format:
1.  A single line with the EXACT prefix \`File: path/to/the/file.ext\`.
2.  Immediately after, a markdown code block containing the **ENTIRE, COMPLETE** content of the file.
- **DO NOT** use placeholders or comments like "// ... keep existing code".
- **DO NOT** add any text between the \`File:\` line and the code block.

Example:
File: src/components/Button.js
\`\`\`javascript
function Button({ text }) {
  return <button>{text}</button>;
}
export default Button;
\`\`\``;

            const diffInstruction = `To patch a file, you MUST use the following two-part format:
1.  A single line with the EXACT prefix \`Diff: path/to/the/file.ext\`.
2.  Immediately after, a \`diff\` markdown code block with the patch content.

Example:
Diff: src/app.js
\`\`\`diff
@@ -10,1 +10,1 @@
- console.log("Hello World");
+ console.log("Hello, Lollms!");
\`\`\``;
            
            const locateInstruction = `To insert or replace code at a specific line, use a \`locate\` code block:
\`\`\`locate
file: path/to/your/file.ext
line: 123
action: insert_after
---
const newCode = "goes here";
\`\`\`
- Supported actions: \`insert_after\`, \`replace_line\`.`;

            if (fileUpdateMethod === 'full_file') {
                updateInstructions = fullFileInstruction;
            } else if (fileUpdateMethod === 'diff') {
                updateInstructions = diffInstruction;
            } else if (fileUpdateMethod === 'locate') {
                updateInstructions = locateInstruction;
            } else if (fileUpdateMethod === 'do_your_best') {
                updateInstructions = `You can choose the best method for file modifications. Here are your options and examples:

<hr>

**Option 1: Full File (Best for new files or major changes)**
${fullFileInstruction}

<hr>

**Option 2: Diff (Best for small, targeted changes)**
${diffInstruction}

<hr>

**Option 3: Locate (Best for precise insertions)**
${locateInstruction}

<hr>
`;
            }


            basePrompt = `**YOU ARE A VSCODE ASSISTANT. YOUR OUTPUT IS PROGRAMMATICALLY PARSED. FOLLOW ALL FORMATTING RULES EXACTLY.**

<CRITICAL_INSTRUCTIONS>
1.  **File Modifications:**
    ${updateInstructions}

2.  **File Management (Use these special code blocks ONLY):**
    -   **To Move/Rename:** Use a \`rename\` block with \`old -> new\`. The UI will show a "Move/Rename" button.
        \`\`\`rename
        path/to/old_file.ext -> path/to/new_file.ext
        \`\`\`
    -   **To Delete:** Use a \`delete\` block with one file path per line. The UI will show a "Delete" button.
        \`\`\`delete
        path/to/file_to_delete.ext
        another/file/to_delete.js
        \`\`\`
    -   **To Request Context:** If you need to see files not in your context, use a \`select\` block. The UI will show an "Add to Context" button.
        \`\`\`select
        src/api/auth.ts
        src/utils/database.ts
        \`\`\`

3.  **Image Generation:**
    -   Use \`File: path/to/image.png\` followed by an \`image_prompt\` code block.

4.  **General Conversation:**
    -   If no file operations are needed, respond naturally in standard Markdown. DO NOT use the special file-related formats.
</CRITICAL_INSTRUCTIONS>

<MASTER_RULE>
Any deviation from these formats, especially the \`File:\` prefix and code block structure, will break the extension. Adhere to them with absolute precision.
</MASTER_RULE>`;
            personaKey = 'chatPersona';
            break;
        }
        case 'agent':
        case 'inspector':
        case 'commit':
            // These prompts are defined in their respective managers/integrations
            // and don't need a base here. We just need the persona.
            personaKey = `${promptType}Persona`;
            break;
    }

    const userPersona = config.get<string>(personaKey) || '';
    let combinedPrompt = `${thinkingInstructions}${basePrompt}\n\n**USER CUSTOMIZATION / PERSONA:**\n${userPersona}`;

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

    if (noThinkMode) {
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