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

    let basePrompt = '';
    let personaKey = '';

    switch (promptType) {
        case 'chat':
            basePrompt = `**CRITICAL RESPONSE FORMATTING RULES:**
1.  **For File Modifications (Creating or Overwriting):**
    -   You MUST prefix your response with a single line in this EXACT format: \`File: path/to/the/file.ext\`
    -   This line MUST be on its own, followed by a newline.
    -   Immediately after, provide the new content in a single markdown code block.
    -   Your code block MUST contain the **entire, final content of the file** from beginning to end.
    -   **DO NOT use placeholders**, ellipses (...), or comments like "// ... keep existing code". The extension requires the full file content to apply changes correctly.
    -   DO NOT add any conversational text or explanations before the \`File:\` line or after the code block.
2.  **For Patches (Advanced):**
    -   You MUST prefix your response with a single line: \`Patch: path/to/the/file.ext\`
    -   Follow this with the content in a standard \`.diff\` format inside a code block.
3.  **For General Conversation (When NOT editing a file):**
    -   Respond naturally in Markdown. Do NOT use the \`File:\` or \`Patch:\` prefixes.
4.  **For Executable Commands:**
    -   To suggest an action for the user to take, use the following syntax: \`[command:command_name]{"json_parameters"}\`
    -   The extension will render this as a button for the user to click.
    -   **Available Commands:**
        -   \`createNotebook\`: Creates a new, unsaved Jupyter Notebook.
            -   Example: \`[command:createNotebook]{"path": "analysis.ipynb", "cellContent": "# My New Analysis\\n\\nLet's start by importing pandas."}\`
        -   \`gitCommit\`: Populates the Source Control commit message box.
            -   Example: \`[command:gitCommit]{"message": "feat(api): Add new endpoint for user profiles"}\`
    -   Use these commands when a direct action is more appropriate than just providing code or text.`;
            personaKey = 'chatPersona';
            break;
        
        case 'agent':
            basePrompt = `You are a specialized AI agent operating inside VS Code. Your purpose is to act as a sub-agent to a main planning agent. You will be given a specific task to perform, along with context about the main objective and the project. Follow instructions precisely.`;
            personaKey = 'agentPersona';
            break;

        case 'inspector':
            basePrompt = `**CRITICAL RESPONSE RULES:**
1.  **If the code is perfect:** Your ONLY response must be the word \`OK\`.
2.  **If you find minor bugs (e.g., missing imports, syntax errors):** Your response MUST contain ONLY the corrected, complete code block. Do not add explanations.
3.  **If you find a serious vulnerability (e.g., SQL injection, XSS):** Your response MUST start with a clear, bold warning in this format: \`**⚠️ VULNERABILITY DETECTED:** <Brief explanation>\`. After the warning, provide the corrected, complete code block.
4.  **If you find malicious code (e.g., code that deletes files, exfiltrates data):** Your response MUST start with a critical, bold warning: \`**🚨 CRITICAL ALERT: MALICIOUS CODE DETECTED.** <Brief explanation>\`. DO NOT provide a code block in this case.`;
            personaKey = 'codeInspectorPersona';
            break;

        case 'commit':
             basePrompt = `**CRITICAL INSTRUCTIONS:**
1.  **COMMIT MESSAGE ONLY:** Your entire response MUST be the commit message text.
2.  **NO EXTRA TEXT:** Do not add any conversational text, explanations, apologies, or markdown formatting like \`\`\`.
3.  **CONVENTIONAL FORMAT:** Follow the conventional commit format: \`<type>(<scope>): <subject>\`.
    -   \`<type>\` can be: \`feat\`, \`fix\`, \`docs\`, \`style\`, \`refactor\`, \`test\`, \`chore\`, \`perf\`.
    -   \`<scope>\` is optional and describes the part of the codebase affected.
    -   \`<subject>\` is a short, imperative-tense description of the change.
4.  **SINGLE LINE:** Prioritize a concise single-line message. You can add a blank line followed by a more detailed body ONLY if necessary.

**FORBIDDEN ACTIONS:**
-   **DO NOT** write any code.
-   **DO NOT** explain the changes in conversational text.
-   **DO NOT** use markdown.
-   **DO NOT** add prefixes like "Commit message:".`;
             personaKey = 'commitMessagePersona';
             break;
    }

    const userPersona = config.get<string>(personaKey) || '';
    let combinedPrompt = `${basePrompt}\n\n**USER CUSTOMIZATION / PERSONA:**\n${userPersona}`;

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    const platform = os.platform();
    
    let processedPrompt = combinedPrompt
        .replace(/{{date}}/g, date)
        .replace(/{{time}}/g, time)
        .replace(/{{datetime}}/g, `${date} ${time}`)
        .replace(/{{os}}/g, platform);

    let finalPrompt = processedPrompt.trim();

    if (noThinkMode) {
        finalPrompt = `/no_think\n${finalPrompt}`;
    }

    return finalPrompt ? `${finalPrompt}\n\n` : '';
}


export function stripThinkingTags(responseText: string): string {
    const thinkRegex = /<(think|thinking)>[\s\S]*?<\/\1>/g;
    return responseText.replace(thinkRegex, '').trim();
}