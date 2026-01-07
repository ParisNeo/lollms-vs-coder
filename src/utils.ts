import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { MemoryManager } from './memoryManager';

export interface HerdParticipant {
    model: string;
    personality: string;
}

export interface DiscussionCapabilities {
    codeGenType: 'full' | 'diff' | 'none';
    allowedFormats: {
        fullFile: boolean;
        insert: boolean;
        replace: boolean;
        delete: boolean;
    };
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
    // Herd Mode Settings
    herdMode: boolean;
    herdParticipants: HerdParticipant[];
    herdRounds: number;
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
    // REMOVED: await document.save(); 
    // We leave the document dirty so the user can review changes.
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
    const outputFormat = config.get<string>('outputFormat') || 'legacy';
    
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
        const thinkingStrategies: Record<string, string> = {
            'chain_of_thought': 'Break down the request into logical steps. Analyze implementation strategies, identify potential conflicts, and evaluate trade-offs before writing code.',
            'chain_of_verification': 'Generate a preliminary solution. Identify claims or logic requiring verification. Verify against project context. Produce the final, verified response.',
            'plan_and_solve': 'Create a high-level plan. Review for efficiency and correctness. Execute the plan step by step.',
            'self_critique': 'Generate initial response. Critically review for logic flaws, security vulnerabilities, and bugs. Output the refined, corrected answer.',
            'custom': config.get<string>('thinkingModeCustomPrompt') || ''
        };

        const strategy = thinkingStrategies[thinkingMode];
        if (strategy) {
            thinkingInstructions = `<reasoning_protocol>\nEnclose all reasoning, analysis, and self-correction in <thinking> or <analysis> tags. This internal process is hidden from the user but critical for quality.\n\nProcess: ${strategy}\n</reasoning_protocol>\n\n`;
        }
    }

    let basePrompt = '';

    switch (promptType) {
        case 'chat': {
            const allowed = capabilities?.allowedFormats || config.get<any>('allowedFileFormats') || { fullFile: true, insert: false, replace: false, delete: false };

            // Build format instructions based on output mode
            let formatInstructions = '';
            
            if (outputFormat === 'xml' && allowed.fullFile) {
                formatInstructions = `### File Modification Format (XML)

<file path="relative/path/to/file.ext">
[Complete file content]
</file>

**Requirements:**
- Path must be relative to workspace root
- Content replaces entire file or creates new file
- Include EVERY line - no placeholders or "rest as before" comments
- Do not wrap the <file> tag in code blocks`;

            } else if (outputFormat === 'aider' && allowed.fullFile) {
                formatInstructions = `### File Modification Format (Search/Replace)

relative/path/to/file.ext
<<<<<<< SEARCH
[Exact lines from original file]
=======
[New lines to replace with]
>>>>>>> REPLACE

**Requirements:**
- SEARCH block must match file content exactly (including whitespace)
- For new files, provide full content in code block with \`language:path/to/file\` header
- Do not wrap block markers in markdown code fences`;

            } else if (allowed.fullFile) {
formatInstructions = `### File Creation/Modification Format

When you need to create or modify a file, you MUST output a code block using this structure:

1. Start with three backticks: \`\`\`
2. Immediately after (no space), write: language:path
3. Press enter and write the complete file content
4. End with three backticks: \`\`\`

**Template to follow:**
\`\`\`language:relative/path/to/file.ext
[complete file content here]
\`\`\`

**Real example:**
\`\`\`python:src/config.py
"""Configuration for the app."""

DEBUG = True
PORT = 8000
\`\`\`

**RULES:**
- Always wrap file content in a code block (three backticks)
- The first line after opening backticks must be: language:path
- Include ALL file content, no placeholders
- Do not write "Now I will modify..." - just output the code block
- Do not explain before the code block - output it first, then explain if needed

**Your response should look like:**
\`\`\`python:src/myfile.py
# complete code here
\`\`\`

That's the file updated! [optional explanation]`;           }

            // Add optional modification formats
            let additionalFormats = '';
            if (allowed.insert) {
                additionalFormats += `\n### Insert Code

\`\`\`insert:relative/path/to/file.ext
<<<<
[Context lines to locate insertion point]
====
[New code to insert after context]
>>>>
\`\`\``;
            }

            if (allowed.replace) {
                additionalFormats += `\n### Replace Code

\`\`\`replace:relative/path/to/file.ext
<<<<
[Exact original code to replace]
====
[New code to replace with]
>>>>
\`\`\`

Note: Original code must match exactly or operation fails`;
            }

            if (allowed.delete) {
                additionalFormats += `\n### Delete Code

\`\`\`delete_code:relative/path/to/file.ext
<<<<
[Exact code to delete]
>>>>
\`\`\`

Note: Code must match exactly or operation fails`;
            }

            // File operations
            let fileOperations = '';
            if (!capabilities || capabilities.fileRename) {
                fileOperations += '- **Rename/Move:** `<rename old="old/path.ext" new="new/path.ext" />`\n';
            }
            if (!capabilities || capabilities.fileDelete) {
                fileOperations += '- **Delete File:** `<delete path="path/to/file.ext" />`\n';
            }
            if (!capabilities || capabilities.fileSelect) {
                fileOperations += '- **Add to Context:** `<select path="path/to/file.ext" />`\n';
            }

            if (fileOperations) {
                additionalFormats += `\n### File Operations\nUse standard XML style for file management:\n${fileOperations}`;
            }

            // Search capability
            const searchCapability = capabilities?.webSearch ? `\n### Web Search

Trigger automated web search when you need current information or documentation:

<web_search>search query</web_search>

The extension fetches results, appends them to context, and asks you to continue.` : '';

            // Image generation
            const imageGenCapability = capabilities?.imageGen ? `\n### Image Generation

Generate images using:

\`\`\`image_prompt
[Detailed image description]
\`\`\`` : '';

            basePrompt = `# Role

You are a Senior VSCode Engineering Assistant with expertise in software architecture, design patterns, and pedagogical code explanation.

${thinkingInstructions}# Response Structure

1. **Start with explanation and analysis** - Use \`<analysis>\` tags to share your findings and logic before any code
2. **Teach concepts** - Help the developer understand architecture and design decisions
3. **Format Strictness** - Use EXCLUSIVELY the formats defined below.
4. **Maintain file integrity** - When replacing full files, include every single line

# Strict Format Enforcement (CRITICAL)

You must use **EXCLUSIVELY** one of the supported file modification formats defined above.
❌ **DO NOT** produce standard git patches (e.g., lines starting with \`--- a/file\` or \`+++ b/file\`).
❌ **DO NOT** produce unified diffs.
❌ **DO NOT** use generic code blocks without the \`language:path\` header if the code is meant to be written to a file.

${formatInstructions}${additionalFormats}${searchCapability}${imageGenCapability}

# Core Principles

- Analysis before action - never output code blocks without context
- Format compliance is mandatory - exact syntax required
- Full file replacements must be complete - no shortcuts or omissions
- Clear, concise, pedagogical communication`;

            break;
        }

        case 'agent':
            basePrompt = `# Role

You are an autonomous AI Agent executing tasks systematically.

${thinkingInstructions}# Core Principles

- Observe tool outputs carefully before proceeding
- Verify success/failure from actual responses
- Never assume operations succeeded without confirmation
- Report errors clearly when they occur
- Complete tasks step-by-step with verification at each stage
- **STRICT FORMATTING:** Never use git patches or diffs. Use the provided tools (e.g. \`generate_code\`) or format instructions strictly.`;
            break;

        case 'inspector':
            basePrompt = `# Role

You are a Code Quality Inspector analyzing code for issues, improvements, and best practices.

${thinkingInstructions}# Analysis Focus

- Code quality and maintainability
- Security vulnerabilities
- Performance bottlenecks
- Best practice violations
- Potential bugs and edge cases
- Architecture and design patterns`;
            break;

        case 'commit':
            basePrompt = `# Role

Expert developer writing conventional commit messages.

# Output Format

\`\`\`
type(scope): concise description

- Key change 1
- Key change 2
\`\`\`

# Requirements

- Use conventional commit types (feat, fix, docs, refactor, test, chore)
- Keep description under 50 characters
- Output ONLY the code block
- No additional commentary`;
            break;
    }

    // Build context sections
    const contextSections: string[] = [];

    // User context
    const userInfo = [
        `- Name: ${userName}`,
        userEmail && `- Email: ${userEmail}`,
        userStyle && `- Coding Style: ${userStyle}`,
        userLicense && `- Default License: ${userLicense}`
    ].filter(Boolean).join('\n');

    if (userInfo) {
        contextSections.push(`### User Context\n${userInfo}`);
    }

    // Memory
    if (memoryContent.trim()) {
        contextSections.push(`### Long-Term Memory\n\`\`\`\n${memoryContent}\n\`\`\`\n\nUpdate memory with <memory>content</memory> tags when learning important preferences or patterns.`);
    }

    // Persona
    let personaContent = customPersonaContent || config.get<string>(
        promptType === 'chat' ? 'chatPersona' :
        promptType === 'agent' ? 'agentPersona' :
        promptType === 'inspector' ? 'codeInspectorPersona' :
        'commitMessagePersona'
    ) || '';

    if (capabilities?.funMode) {
        personaContent += "\n\n**FUN MODE** 🎉: Be quirky, humorous, and use emojis liberally!";
    }

    if (personaContent.trim()) {
        contextSections.push(`### Your Persona\n${personaContent.trim()}`);
    }

    // Combine prompt sections
    const contextBlock = contextSections.length > 0 ? '\n\n# Context\n\n' + contextSections.join('\n\n') : '';
    let combinedPrompt = `${basePrompt}${contextBlock}`;

    // Variable substitution
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const platform = os.platform();
    
    combinedPrompt = combinedPrompt
        .replace(/{{date}}/g, date)
        .replace(/{{os}}/g, platform)
        .replace(/{{developer_name}}/g, userName);

    // Add reasoning prefix if needed
    let finalPrompt = combinedPrompt.trim();
    if (thinkingMode === 'no_think') {
        finalPrompt = `/no_think\n${finalPrompt}`;
    } else if (reasoningLevel !== 'none') {
        finalPrompt = `/reasoning_${reasoningLevel}\n${finalPrompt}`;
    }

    return finalPrompt ? `${finalPrompt}\n\n` : '';
}

export function stripThinkingTags(responseText: string): string {
    const thinkRegex = /<(think|thinking|analysis)>[\s\S]*?<\/\1>/g;
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