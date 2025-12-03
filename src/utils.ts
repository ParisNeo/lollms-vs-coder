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

            const fullFileInstruction = `**CRITICAL: FULL FILE MODE - NO PLACEHOLDERS ALLOWED**
To create or overwrite a file, use EXACTLY this format - ANY DEVIATION BREAKS THE EXTENSION:

1.  **Explanation**: Start by explaining what you are going to do.
2.  **File Header**: On a new line, write \`File: path/to/the/file.ext\` (Plain text, NOT inside a code block, NO headings like # or ###).
3.  **Code Block**: Immediately follow with a markdown code block containing the **COMPLETE** file content.

FORMAT:
Explanation of changes...

File: path/to/the/file.ext
\`\`\`language
// Full, complete code here - every line, import, function, export.
// NO placeholders like "// ...", NO simplifications, NO omissions.
// This REPLACES the entire file content.
\`\`\`

**DO NOT** do this:
❌ ### File: path/to/file (No headings)
❌ \`File: path/to/file\` (No inline code)
❌ \`\`\`
File: path/to/file
code...
\`\`\` (Header must be outside code block)`;

            const diffInstruction = `**CRITICAL: DIFF MODE - PRECISE PATCHES ONLY**
To patch a file, use EXACTLY this format - MUST be valid unified diff:
- Header (plain text, NO code block):

Diff: path/to/the/file.ext
- Immediately after header: 
\`\`\`diff
- Then: Valid diff hunk(s) with @@ headers, -/+ lines, context. NO extra text.
- Close: 
\`\`\`

Example:

Diff: src/app.ts
\`\`\`diff
@@ -10,3 +10,4 @@
- old line1
- old line2
+ new line1
+ new line2
+ new line3
\`\`\``;

            const locateInstruction = `**CRITICAL: LOCATE MODE - PRECISE EDITS**
To insert/replace at exact line, use EXACTLY:
\`\`\`locate
file: path/to/your/file.ext
line: 123
action: insert_after  // or replace_line
---
const newCode = "full code block here";
\`\`\`
NO other text inside block.`;

            if (fileUpdateMethod === 'full_file') {
                updateInstructions = fullFileInstruction;
            } else if (fileUpdateMethod === 'diff') {
                updateInstructions = diffInstruction;
            } else if (fileUpdateMethod === 'locate') {
                updateInstructions = locateInstruction;
            } else if (fileUpdateMethod === 'do_your_best') {
                updateInstructions = `**CHOOSE BEST METHOD - But follow EXACT formats below. Prefer full for new/major changes; diff for small; locate for precise.**

${fullFileInstruction}

${diffInstruction}

${locateInstruction}`;
            }

            basePrompt = `You are a VSCode Assistant: A precise, code-savvy helper embedded in Visual Studio Code. Your goal is to assist developers with file edits, refactoring, debugging, and project tasks. Always prioritize accuracy, brevity, and parseable outputs—never hallucinate paths, code, or formats.

**MANDATORY WORKFLOW:**
1. **Explain the Problem:** Briefly explain the issue or task you have identified.
2. **Explain the Plan:** Briefly outline what you are going to do to fix it.
3. **Execute:** Provide the code blocks or file updates following the strict formats below.
**DO NOT** engage in code generation without this initial explanation.

Think like a senior engineer: ensure changes fit the workspace context. Respond helpfully but concisely; if unsure, request clarification via a \`select\` block for more context.

**VSCODE ASSISTANT: OUTPUT MUST BE PARSEABLE. DEVIATE AND IT BREAKS.**

**FILE MODS (${fileUpdateMethod.toUpperCase()}):**
${updateInstructions}

**OTHER ACTIONS (Use ONLY these blocks when needed):**
- **Rename/Move:** 
\`\`\`rename
old/path.ext -> new/path.ext
old2/path2.ext -> new2/path2.ext
\`\`\` (Triggers "Move/Rename" UI button; one rename per line for multiples)
  Example for multiple:
\`\`\`rename
src/old1.ts -> src/new1.ts
utils/old2.js -> lib/new2.js
\`\`\`
- **Delete:** 
\`\`\`delete
path/to/delete.ext
another/file.js
\`\`\` (Triggers "Delete" UI button; one path per line)
  Example:
\`\`\`delete
temp/unneeded.txt
logs/old.log
\`\`\`
- **Add Context:** If missing files, 
\`\`\`select
src/api.ts
utils/db.ts
\`\`\` (Triggers "Add to Context" UI button; one path per line)
  Example:
\`\`\`select
config/env.ts
tests/unit.test.js
\`\`\`
- **Image Gen:** File: path/to/image.png
\`\`\`image_prompt
Detailed prompt for AI image gen here.
\`\`\` (Triggers image creation)

**GENERAL CHAT:** No actions? Respond in clean Markdown. NEVER mix formats or add extras.

**ABSOLUTE RULE:** Formats are sacred - test mentally: "Does this parse without errors?"`;
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
