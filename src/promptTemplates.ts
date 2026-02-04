import * as vscode from 'vscode';
import * as os from 'os';
import { DiscussionCapabilities, getAvailableShells, ResponseProfile } from './utils';

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
        
        // Get Profiles
        const profiles = config.get<ResponseProfile[]>('responseProfiles') || [];
        const activeProfileId = capabilities?.responseProfileId || config.get<string>('defaultResponseProfileId') || 'balanced';
        const activeProfile = profiles.find(p => p.id === activeProfileId) || profiles[0];

        let persona = customPersonaContent || config.get<string>(
            promptType === 'chat' ? 'chatPersona' :
            promptType === 'agent' ? 'agentPersona' :
            promptType === 'inspector' ? 'codeInspectorPersona' :
            'commitMessagePersona'
        ) || "You are an expert software engineer.";

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
1. **NATIVE TOOL PRIORITY**: You MUST use the provided tools (e.g., \`moltbook_action\`, \`read_file\`) directly. **DO NOT** create Python scripts (like \`interact.py\`) to call APIs unless the tool does not exist.
2. **Efficiency**: Check the history. If a task was already completed successfully, do not repeat it.
3. **Project Memory**: Use \`.lollms/research_notes.md\` to store useful snippets from the web.
4. **Investigation**: If you lack knowledge, use \`research_web_page\` or \`analyze_image\` before committing to a plan.
5. **Skill Application**: If a **Skill** is in the context, strictly follow its documentation.
` : '';

        // INJECT CONFIGURABLE RESPONSE INSTRUCTIONS from Profile
        const responseInstructions = activeProfile ? `\n${activeProfile.systemPrompt}\n` : "";
        const prefix = (activeProfile && activeProfile.prefix) ? activeProfile.prefix + "\n" : "";

        const shellNote = os.platform() === 'win32' 
            ? "\n### WINDOWS SHELL NOTE\nYou are in a PowerShell environment. \n- **CRITICAL**: Use \`curl.exe\` instead of \`curl\` to avoid PowerShell alias issues.\n- Ensure strings in commands are escaped correctly for PowerShell."
            : "";

        const finalInstruction = forceFullCode 
            ? `\n# FINAL INSTRUCTION\nYou MUST return the FULL CONTENT of any modified files. Do not output diffs or partial snippets.`
            : `\n# FINAL INSTRUCTION\nEnsure all code modifications are surgical and anchored correctly to the source text. Never hallucinate the position of code.`;

        const treeContext = context?.tree || "(No project tree)";
        const filesContext = context?.files || "(No files selected)";
        const skillsContext = context?.skills || "(No skills loaded)";

        const promptBody = `# Personality ROLE
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
${responseInstructions}
${env}${agentProtocols}${shellNote}
${finalInstruction}`;

        return prefix + promptBody;
    }
}
