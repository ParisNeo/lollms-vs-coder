import * as vscode from 'vscode';
import * as os from 'os';
import { DiscussionCapabilities } from './utils';

/**
 * This file centralizes all system prompt logic to ensure consistent AI behavior
 * across different modules (Chat, Agent, Inspector, etc.)
 */

export class PromptTemplates {
    
    /**
     * Build formatting instructions based on the user's preferred output format.
     */
    private static getFormatInstructions(outputFormat: string, capabilities?: DiscussionCapabilities, forceFullCode?: boolean): string {
        
        // 1. Force Full Code Mode (Overrides everything else)
        if (forceFullCode) {
            return `
## FILE MODIFICATION RULES (STRICT FULL CONTENT)
You must ALWAYS provide the **FULL, COMPLETE CONTENT** of any file you modify.
**DO NOT** use diffs, patches, \`<<< SEARCH\`, or partial snippets.
**DO NOT** leave placeholders like \`# ... rest of code ...\`.

Format:
\`\`\`language:path/to/file.ext
[Complete file content here]
\`\`\`
`;
        }

        // 2. Aider Mode
        if (outputFormat === 'aider') {
            return `
## FILE MODIFICATION RULES (SEARCH/REPLACE MODE)
You must use surgical SEARCH/REPLACE blocks to modify files. This is the most reliable way to ensure code is placed correctly.

Format:
\`\`\`python:path/to/file.py
<<<<<<< SEARCH
[exact original code snippet]
=======
[new replacement code]
>>>>>>> REPLACE
\`\`\`

Rules for SEARCH/REPLACE:
1. **Uniqueness**: The SEARCH block must contain enough code to be unique within the file. Include at least 2-3 surrounding lines.
2. **Exactness**: The SEARCH block must match the original file content character-for-character, including indentation and comments.
3. **Surgicality**: Only change what is necessary. Do not rewrite the whole function if only one line is wrong.
4. **Completion**: Do not use placeholders like "..." inside the blocks.
`;
        }

        // 3. XML Mode
        if (outputFormat === 'xml') {
            return `
## FILE MODIFICATION RULES (XML MODE)
Use the following XML structure to provide file content:
<file path="relative/path/to/file.ext">
[full file content here]
</file>

If you are performing surgical edits, use:
<replace path="path/to/file.ext">
  <search>
    [exact snippet to find]
  </search>
  <replacement>
    [new code]
  </replacement>
</replace>
`;
        }

        // 4. Legacy / Default Mode
        return `
## FILE MODIFICATION RULES (UNIFIED DIFF)
You must provide code changes using standard Unified Diff format or Full File format.

### Option 1: Surgical Patch (Preferred for small fixes)
Include exact context lines to avoid positional errors.
\`\`\`diff:path/to/file.py
--- a/path/to/file.py
+++ b/path/to/file.py
@@ ... @@
[context line]
-[old line]
+[new line]
[context line]
\`\`\`

### Option 2: Full File (Preferred for new or small files)
\`\`\`python:path/to/file.py
[complete, executable file content]
\`\`\`

**CRITICAL**: When using diffs, you must ensure the lines surrounding your change match the source code EXACTLY. Do not move code to the end of functions if it belongs at the top.
`;
    }

    /**
     * Main entry point to generate a system prompt.
     */
    public static async getSystemPrompt(
        promptType: 'chat' | 'agent' | 'inspector' | 'commit',
        capabilities?: DiscussionCapabilities,
        customPersonaContent?: string,
        memory?: string,
        forceFullCode?: boolean
    ): Promise<string> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const outputFormat = config.get<string>('outputFormat') || 'legacy';
        const userName = config.get<string>('userInfo.name') || 'Developer';
        const thinkingMode = capabilities?.thinkingMode || config.get<string>('thinkingMode') || 'none';

        // 1. Define Persona
        let persona = customPersonaContent || config.get<string>(
            promptType === 'chat' ? 'chatPersona' :
            promptType === 'agent' ? 'agentPersona' :
            promptType === 'inspector' ? 'codeInspectorPersona' :
            'commitMessagePersona'
        ) || "You are an expert software engineer.";

        if (capabilities?.funMode) persona += " Be extremely enthusiastic and use emojis!";

        // 2. Add Thinking/Reasoning Instructions
        let thinking = '';
        if (thinkingMode !== 'none' && thinkingMode !== 'no_think') {
            thinking = `\n### REASONING PROTOCOL\nBefore outputting code, analyze the file structure. Specifically:
- Identify the exact line number or unique text block where a bug exists.
- Ensure your edit anchors (SEARCH block or Diff context) are unique and correctly ordered relative to the rest of the function.\n`;
        }

        // 3. Assemble Environment Context
        const env = `
### ENVIRONMENT INFO
- OS: ${os.platform()}
- Developer: ${userName}
- Date: ${new Date().toISOString().split('T')[0]}
${memory ? `\n### LONG-TERM MEMORY\n${memory}` : ''}`;

        // 4. Assemble Formatting
        const formatting = this.getFormatInstructions(outputFormat, capabilities, forceFullCode);

        // 5. Final Instruction Adjustment based on Force Code
        const finalInstruction = forceFullCode 
            ? `\n# FINAL INSTRUCTION\nYou MUST return the FULL CONTENT of any modified files. Do not output diffs or partial snippets.`
            : `\n# FINAL INSTRUCTION\nEnsure all code modifications are surgical and anchored correctly to the source text. Never hallucinate the position of code.`;

        const prompt = [
            `# ROLE\n${persona}`,
            thinking,
            formatting,
            env,
            finalInstruction
        ].join('\n\n');

        return thinkingMode === 'no_think' ? `/no_think\n${prompt}` : prompt;
    }
}