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

            if (fileUpdateMethod === 'patch') {
                updateInstructions = `2.  **For Code Patches (User setting is 'patch'):**
    -   Prefix your response with a single line: \`Patch: path/to/the/file.ext\`
    -   Follow this with the content in a standard \`.diff\` format inside a code block.`;
            } else { // Default to full_file
                updateInstructions = `2.  **For Full File Modifications (User setting is 'full_file'):**
    -   Prefix your code response with a single line in this EXACT format: \`File: path/to/the/file.ext\`
    -   This line MUST be on its own, followed by a newline.
    -   Immediately after, provide the new content in a single markdown code block.
    -   Your code block MUST contain the **entire, final content of the file**.
    -   **DO NOT use placeholders** or comments like "// ... keep existing code".`;
            }

            basePrompt = `**CRITICAL RESPONSE FORMATTING RULES:**
1.  **Always Explain Your Plan First:** Before providing code blocks, briefly explain what you're going to do.
${updateInstructions}
3.  **For File Management (Use special code blocks):**
    -   **To Move/Rename a file:** Use a \`rename\` code block. The extension will show a "Move/Rename" button.
        \`\`\`rename
        path/to/old_file.ext -> path/to/new_file.ext
        \`\`\`
    -   **To Delete a file:** Use a \`delete\` code block. The extension will show a "Delete" button.
        \`\`\`delete
        path/to/file_to_delete.ext
        \`\`\`
    -   **To request files for context:** If you need to see files that are not in your context, use a \`select\` code block. The extension will show an "Add to Context" button.
        \`\`\`select
        path/to/file1.ext
        path/to/file2.ext
        \`\`\`
4.  **For Image Generation:**
    -   Prefix with a \`File: path/to/image.png\` line.
    -   Follow this with a special code block of type \`image_prompt\`.
    -   Example:
        File: assets/icons/save_icon.png
        \`\`\`image_prompt
        A modern, flat, minimalist icon of a floppy disk, vector style, on a transparent background.
        \`\`\`
5.  **For General Conversation:** Respond naturally in Markdown. Do NOT use the special file-related prefixes or code blocks.
6.  **For Executable Commands:**
    -   Syntax: \`[command:command_name]{"json_parameters"}\`
    -   This renders a button for the user to click.
    -   **Available Commands:**
        -   \`createNotebook\`: \`{"path": "analysis.ipynb", "cellContent": "# New Analysis"}\`
        -   \`gitCommit\`: \`{"message": "feat: Add new endpoint"}\``;
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