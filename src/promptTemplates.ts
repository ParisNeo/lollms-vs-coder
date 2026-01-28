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
    private static getFormatInstructions(capabilities?: DiscussionCapabilities, forceFullCode?: boolean): string {
        
        // 1. Force Full Code Mode (Overrides everything else)
        if (forceFullCode) {
            return `
### FILE MODIFICATION RULES (STRICT FULL CONTENT)
You must ALWAYS provide the **FULL, COMPLETE CONTENT** of any file you modify.
**DO NOT** use diffs, patches, \`<<< SEARCH\`, or partial snippets.
**DO NOT** leave placeholders like \`# ... rest of code ...\`.

Format:
\`\`\`language:path/to/file.ext
[Complete file content here]
\`\`\`
`;
        }

        // --- DYNAMIC FORMAT SELECTION ---
        let allowedFormats = [];
        let formatInstructions = "";
        let logicInstructions = "";

        // Default if capabilities are missing (legacy fallback)
        let useFull = true;
        let useDiff = false;
        let useAider = false;

        if (capabilities && capabilities.generationFormats) {
            useFull = capabilities.generationFormats.fullFile;
            useDiff = capabilities.generationFormats.diff;
            useAider = capabilities.generationFormats.aider;
        }

        // Add Full File Format
        if (useFull) {
            allowedFormats.push("Full File Content");
            formatInstructions += `
#### Option: Full File (Preferred for new or small files)
\`\`\`python:path/to/file.py
[complete, executable file content]
\`\`\`
`;
        }

        // Add Aider Format
        if (useAider) {
            allowedFormats.push("SEARCH/REPLACE Block");
            formatInstructions += `
#### Option: Surgical Search/Replace (Preferred for specific edits)
\`\`\`python:path/to/file.py
<<<<<<< SEARCH
[exact original code snippet]
=======
[new replacement code]
>>>>>>> REPLACE
\`\`\`
*Rules for SEARCH/REPLACE:*
1. **Uniqueness**: The SEARCH block must contain enough code to be unique within the file.
2. **Exactness**: The SEARCH block must match the original file content character-for-character.
`;
        }

        // Add Diff Format
        if (useDiff) {
            allowedFormats.push("Unified Diff");
            formatInstructions += `
#### Option: Unified Diff (For small patches)
\`\`\`diff:path/to/file.py
--- a/path/to/file.py
+++ b/path/to/file.py
@@ ... @@
[context line]
-[old line]
+[new line]
[context line]
\`\`\`
`;
        }

        // Logic for privileging formats
        if (useAider && useDiff) {
            logicInstructions += "PREFERENCE: Use SEARCH/REPLACE (Aider) over Diff when possible for surgical edits.\n";
        }
        
        if (useDiff && useFull && !useAider) {
            logicInstructions += "PREFERENCE: Use Diff for small, localized changes. Use Full File for large refactors or new files.\n";
        }

        if (useAider && useFull) {
             logicInstructions += "PREFERENCE: Use SEARCH/REPLACE for existing files modifications. Use Full File for creating new files.\n";
        }

        return `
### FILE MODIFICATION RULES
You may use the following formats: ${allowedFormats.join(', ')}.

${logicInstructions}

${formatInstructions}

**CRITICAL**: Ensure the lines surrounding your change match the source code EXACTLY. Do not move code to the end of functions if it belongs at the top.
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
        forceFullCode?: boolean,
        context?: { tree: string, files: string, skills: string }
    ): Promise<string> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
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

        // 2. Assemble Formatting Instructions
        const formatting = this.getFormatInstructions(capabilities, forceFullCode);

        // 3. Assemble Environment Context & Final Rules
        const env = `
### ENVIRONMENT INFO
- OS: ${os.platform()}
- Developer: ${userName}
- Date: ${new Date().toISOString().split('T')[0]}
${memory ? `\n### LONG-TERM MEMORY\n${memory}` : ''}`;

        // Reasoning instruction
        let thinking = '';
        if (thinkingMode !== 'none' && thinkingMode !== 'no_think') {
            thinking = `\n### REASONING PROTOCOL\nBefore outputting code, analyze the file structure. Specifically:
- Identify the exact line number or unique text block where a bug exists.
- Ensure your edit anchors (SEARCH block or Diff context) are unique and correctly ordered relative to the rest of the function.\n`;
        }

        // Explanation vs Code Only Logic
        let responseStyle = "";
        const explain = capabilities ? (capabilities.explainCode !== false) : true; // Default true if undefined
        
        if (explain) {
            responseStyle = `
### RESPONSE STYLE
- **CRITICAL**: You MUST always start your response by explaining what you are doing using the following structure:
  1. **Problem**: Describe the issue, request, or logic you are addressing.
  2. **Hypothesis**: Explain your reasoning, the logic of your proposed solution, or your interpretation of the code.
  3. **Fix**: Briefly outline the changes or steps you are about to provide.
- Only after this explanation should you provide code blocks or execute tools.
- Provide clear pedagogical descriptions to teach the user.
`;
        } else {
            responseStyle = `
### RESPONSE STYLE (CODE ONLY MODE)
- Minimize conversational filler.
- Go straight to the code or solution.
- Do NOT explain unless there is a critical ambiguity or error.
`;
        }

        const finalInstruction = forceFullCode 
            ? `\n# FINAL INSTRUCTION\nYou MUST return the FULL CONTENT of any modified files. Do not output diffs or partial snippets.`
            : `\n# FINAL INSTRUCTION\nEnsure all code modifications are surgical and anchored correctly to the source text. Never hallucinate the position of code.`;

        // --- NEW STRUCTURE ---
        const treeContext = context?.tree || "(No project tree)";
        const filesContext = context?.files || "(No files selected)";
        const skillsContext = context?.skills || "(No skills loaded)";

        // Skills placed BEFORE the file tree and content as requested
        const prompt = `# Personality ROLE
${persona}

# Project context:
## Skills
${skillsContext}

## The project files tree 
${treeContext}

## The selected files content
${filesContext}

## Extra files
(No extra files)

## Instructions
${formatting}
${responseStyle}
${thinking}
${env}
${finalInstruction}`;

        return thinkingMode === 'no_think' ? `/no_think\n${prompt}` : prompt;
    }
}
