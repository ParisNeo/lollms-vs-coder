import * as vscode from 'vscode';
import * as os from 'os';
import { DiscussionCapabilities, getAvailableShells } from './utils';

/**
 * This file centralizes all system prompt logic to ensure consistent AI behavior
 * across different modules (Chat, Agent, Inspector, etc.)
 */

export class PromptTemplates {
    
    /**
     * Build formatting instructions based on the user's preferred output format.
     */
    private static getFormatInstructions(capabilities?: DiscussionCapabilities, forceFullCode?: boolean): string {
        
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

        let allowedFormats = [];
        let formatInstructions = "";
        let logicInstructions = "";

        let useFull = true;
        let useDiff = false;
        let useAider = false;

        if (capabilities && capabilities.generationFormats) {
            useFull = capabilities.generationFormats.fullFile;
            useDiff = capabilities.generationFormats.diff;
            useAider = capabilities.generationFormats.aider;
        }

        if (useFull) {
            allowedFormats.push("Full File Content");
            formatInstructions += `
#### Option: Full File (Preferred for new or small files)
\`\`\`python:path/to/file.py
[complete, executable file content]
\`\`\`
`;
        }

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
        const responseMode = capabilities?.responseMode || config.get<string>('responseMode') || 'balanced';

        let persona = customPersonaContent || config.get<string>(
            promptType === 'chat' ? 'chatPersona' :
            promptType === 'agent' ? 'agentPersona' :
            promptType === 'inspector' ? 'codeInspectorPersona' :
            'commitMessagePersona'
        ) || "You are an expert software engineer.";

        if (capabilities?.funMode) persona += " Be extremely enthusiastic and use emojis!";

        const formatting = this.getFormatInstructions(capabilities, forceFullCode);
        const shells = await getAvailableShells();

        const env = `
### ENVIRONMENT INFO
- OS Platform: ${os.platform()} (${os.type()} ${os.release()})
- Developer: ${userName}
- Date: ${new Date().toISOString().split('T')[0]}
- Available Shells: ${shells.join(', ')}
${memory ? `\n### LONG-TERM MEMORY\n${memory}` : ''}`;

        const agentProtocols = promptType === 'agent' ? `
### AGENT AUTONOMY & STATE PROTOCOLS
1. **Self-Evolution**: Extension-provided skills (like Moltbook) are read-only, but you can create/update your own intelligence in \`.lollms/skills/\`. Use \`build_skill\` to refine your capabilities.
2. **CLI for Agent Strategy**: You are encouraged to build and maintain CLI scripts (e.g. \`moltbook_interact.py\`) that allow you to perform complex API tasks via \`execute_command\`. This makes your actions reproducible and robust.
3. **Project Memory**: Use \`.lollms/research_notes.md\` to store useful snippets from the web and \`.lollms/project_state.json\` for persistent variables (API keys, heartbeat state, status).
4. **Investigation**: If you lack a specific skill or API knowledge, use \`research_web_page\` or \`rlm_repl\` to experiment and find answers before committing to a plan.
5. **Skill Application**: If a **Skill** is in the context, you MUST strictly follow its technical documentation for API endpoints and parameters.
` : '';

        let thinking = '';
        if (thinkingMode !== 'none' && thinkingMode !== 'no_think') {
            thinking = `\n### REASONING PROTOCOL\nBefore outputting code, analyze the file structure. Specifically:
- Identify the exact line number or unique text block where a bug exists.
- Ensure your edit anchors (SEARCH block or Diff context) are unique and correctly ordered relative to the rest of the function.\n`;
        }

        let responseStyle = "";
        
        switch (responseMode) {
            case 'silent':
                responseStyle = `
### RESPONSE STYLE: SILENT (CODE ONLY)
- **CRITICAL**: You must provide ONLY code blocks or tool executions.
- **NO CONVERSATION**: Do not explain, apologize, or provide any text outside of the code blocks.
- If you are answering a question that doesn't involve code, use a markdown block.
- Zero verbosity. Zero fluff.
`;
                break;
            case 'pedagogical':
                responseStyle = `
### RESPONSE STYLE: PEDAGOGICAL (TEACH ME EVERYTHING)
- **TEACHING MISSION**: You are a mentor. Your goal is not just to provide code, but to ensure the user understands the concepts, the 'why' behind decisions, and the architecture.
- **DEEP ANALYSIS**: For every task, provide a deep analysis before and after the solution.
- **STRUCTURED BREAKDOWN**:
  1. **Problem Analysis**: A detailed deep-dive into the issue.
  2. **Architectural Decisions**: Why you chose this approach over others.
  3. **Hypothesis**: The logic path leading to the fix.
  4. **The Fix**: The implementation.
  5. **Learning Summary**: Key takeaways and potential edge cases to watch for.
- Use analogies and clear documentation.
`;
                break;
            case 'balanced':
            default:
                responseStyle = `
### RESPONSE STYLE: BALANCED
- **STRUCTURED BREAKDOWN**: You MUST always start your response by explaining what you are doing using this structure:
  1. **Problem**: Describe the issue or request.
  2. **Hypothesis**: Explain your reasoning or approach.
  3. **Fix**: Briefly outline the changes.
- Provide clear descriptions to teach the user while staying concise.
`;
                break;
        }

        const shellNote = os.platform() === 'win32' 
            ? "\n### WINDOWS SHELL NOTE\nYou are in a PowerShell environment. \n- **CRITICAL**: Use \`curl.exe\` instead of \`curl\` to avoid PowerShell alias issues.\n- Ensure strings in commands are escaped correctly for PowerShell."
            : "";

        const finalInstruction = forceFullCode 
            ? `\n# FINAL INSTRUCTION\nYou MUST return the FULL CONTENT of any modified files. Do not output diffs or partial snippets.`
            : `\n# FINAL INSTRUCTION\nEnsure all code modifications are surgical and anchored correctly to the source text. Never hallucinate the position of code.`;

        const treeContext = context?.tree || "(No project tree)";
        const filesContext = context?.files || "(No files selected)";
        const skillsContext = context?.skills || "(No skills loaded)";

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
${env}${agentProtocols}${shellNote}
${finalInstruction}`;

        return thinkingMode === 'no_think' ? `/no_think\n${prompt}` : prompt;
    }
}
