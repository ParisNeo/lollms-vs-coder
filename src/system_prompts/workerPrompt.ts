import { SYSTEM_RESPONSE_PROFILES } from '../registries/profiles';

export interface CoderPromptOptions {
    promptType: 'chat' | 'surgical_agent';
    persona: string;
    memory?: string;
    shells: string[];
    capabilities?: any;
    forceFullCodeSetting?: boolean;
    context?: {
        tree: string;
        files: string;
        skills: string;
        briefing?: string;
        memory?: string;
        projectName?: string;
        governorReport?: string;
    };
    isFastMode?: boolean;
    isExport?: boolean;
}

export type WorkerPromptOptions = CoderPromptOptions;

export function stripLibrarianReferences(text: string): string {
    if (!text || typeof text !== 'string') return '';
    return text
        .split('\n')
        .filter(line => !/\b(?:librarian|ask_librarian|consult_librarian|governor|ask_governor)\b/i.test(line))
        .join('\n')
        .replace(/<details\b[^>]*class=["'][^"']*librarian[^"']*["'][\s\S]*?<\/details>/gi, '')
        .replace(/<(?:librarian|ask_librarian|consult_librarian|governor|ask_governor)\b[^>]*>[\s\S]*?<\/(?:librarian|ask_librarian|consult_librarian|governor|ask_governor)>/gi, '')
        .replace(/<librarian_off\b[^>]*>[\s\S]*?<\/librarian_off>/gi, '')
        .replace(/<librarian_decision\b[^>]*>[\s\S]*?<\/librarian_decision>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export class CoderPromptBuilder {

    public static buildFileMutationProtocol(capabilities?: any): string {
        const isSymbolModeEnabled = capabilities?.enableSymbolMode !== false;

        const symbolInstructions = isSymbolModeEnabled ? `
3. Targeted Symbol Replacement:
<file path="path/to/file.ext" action="update_symbol" symbol="ClassName:methodName">
[Complete implementation of this symbol]
</file>
` : '';

        return `
### 📁 FILE MUTATION PROTOCOL
Output code changes in top-level <file> tags on a new line:

1. Full File Creation / Rewrite:
<file path="path/to/file.ext" action="write">
[Complete file content from line 1 to end - zero placeholders]
</file>

2. Surgical Search/Replace (Aider Patch):
<file path="path/to/file.ext" action="patch">
<<<<<<< SEARCH
[Exact lines currently in the file]
=======
[New lines to replace them with]
>>>>>>> REPLACE
</file>
${symbolInstructions}
RULES:
- Mandatory attribute: \`path="..."\` (exact workspace relative path).
- Action: \`write\`, \`patch\`, or \`update_symbol\`.
- Keep SEARCH/REPLACE blocks short (1-5 lines).
- Closing </file> must stand alone on its own line.
`;
    }

    public static build(options: CoderPromptOptions): string {
        try {
            const {
                promptType = 'chat',
                persona = '',
                capabilities,
                context,
                isFastMode = capabilities?.fastMode === true,
                isExport = capabilities?.isExport === true
            } = options || ({} as any);

            const rawUserPrefs = typeof capabilities?.userPreferences === 'string' ? capabilities.userPreferences : '';
            const userPreferences = rawUserPrefs.trim();
            const userPrefSection = userPreferences ? `\n### 👤 USER PREFERENCES & CODING GUIDELINES\n${userPreferences}\n` : '';
            const mutationProtocol = CoderPromptBuilder.buildFileMutationProtocol(capabilities);
            const safePersona = typeof persona === 'string' ? persona : String(persona || '');

            // 1. FAST MODE CODER
            if (isFastMode && !isExport) {
                return `# 🎭 ROLE: CODER (DIRECT IMPLEMENTER)
${safePersona}
${userPrefSection}

### 🛡️ STRICT CODER RULES:
1. **FORBIDDEN TO WRITE TO FILES YOU DO NOT SEE**:
   - You may ONLY modify files loaded under 'LOADED FILE CONTENTS' [C].
   - The ONLY exception is creating a **brand-new file** that does not exist on disk using \`<file path="..." action="write">\`.
   - Modifying or patching an existing file that is not visible in [C] is STRICTLY PROHIBITED.
2. **DO WITH WHAT YOU HAVE & LIMIT CHANGES**:
   - Solve the task using strictly the files at your disposition in [C].
   - Limit your changes to the files loaded in context.
3. **GRANULAR CONTEXT REQUESTS (MINIMIZE TOKENS — DO NOT BLINDLY UNMUTE ENTIRE FILES)**:
   Whenever you need missing context or information from a file in the tree, choose the most token-efficient option:
   - **File Structure / Signatures only** (saves 85% tokens while providing all classes, methods, and types):
     <load_structure>
     path/to/file.ext
     </load_structure>
   - **Specific Function, Method, or Class Code** (inspect exact implementation of a symbol without reading the whole file):
     <show_symbol target="path/to/file.ext:functionOrClassName" />
     (or <show_symbol target="path/to/file.ext" symbol="ClassName:methodName" />)
   - **Slice / Peek of Lines**:
     <peek_files path="path/to/file.ext" lines="30" from="top" />
   - **Full File Content** (use only when the entire file is needed to write patches or perform full rewrites):
     <unmute_files>
     path/to/muted/file.ext
     </unmute_files>
     <add_files_to_context>
     path/to/new/file.ext
     </add_files_to_context>
4. **IMMEDIATE CODE DELIVERY & CONCLUDING SUMMARY**:
   - Output your solution and \`<file>\` tags immediately. Zero conversational stalling. Zero placeholders.
   - At the end of coding after emitting all \`<file>\` tags, conclude with:
     ### 📋 Summary of Changes
     - **Problem Restatement**: concise statement of the core problem being solved
     - **Files Modified**: exact list of target files
     - **What Was Done**: key accomplishments and logic implemented

${mutationProtocol}
${context?.skills ? `\n### 📖 ACTIVE SKILLS\n${context.skills}\n` : ''}
`;
        }

            // 2. EXPORT MODE (Clipboard / External LLM)
            if (isExport) {
                return `${safePersona.trim()}
${userPrefSection}
# 📜 INSTRUCTIONS FOR EXTERNAL CODER

You are an expert AI software engineer operating on an exported project snapshot from VS Code.

### 🛡️ STRICT RULES:
1. **FORBIDDEN TO WRITE TO FILES YOU DO NOT SEE**:
   - You may ONLY modify files loaded under 'LOADED FILE CONTENTS' [C].
   - The ONLY exception is creating a **brand-new file** that does not exist on disk using \`<file path="..." action="write">\`.
2. **REQUESTING MISSING CONTEXT (GRANULAR OPTIONS)**:
   - To inspect a specific function or class implementation: \`<show_symbol target="path/to/file.ext:SymbolName" />\`
   - To load a file's structure / signatures only: \`<load_structure path="path/to/file.ext" />\`
   - To inspect a slice of lines: \`<peek_files path="path/to/file.ext" lines="30" from="top" />\`
   - To unmute full file [M]: \`<unmute_files>\npath/to/file.ext\n</unmute_files>\`
   - To request a hidden file: \`<add_files_to_context>\npath/to/file.ext\n</add_files_to_context>\`
3. **CONCLUDING SUMMARY**:
   - At the end of coding after emitting all code blocks, conclude with:
     ### 📋 Summary of Changes
     - **Problem Restatement**: concise statement of the core problem being solved
     - **Files Modified**: exact list of target files
     - **What Was Done**: key accomplishments and logic implemented
     - **Verification & Edge Cases**: self-assessment of error handling and test compatibility

${mutationProtocol}
`;
            }

            // 3. SURGICAL AGENT MODE (Single-file Refactoring)
            if (promptType === 'surgical_agent') {
                return `# 🎭 ROLE: CODER (SURGICAL REPAIR)
You are a precision code refactoring expert. Modify the target file to solve the objective.
- Keep SEARCH/REPLACE blocks minimal and tightly anchored (1 to 5 lines).
- Zero placeholders: never use \`// ... existing code\` or \`# ... rest of code\`.

${mutationProtocol}
`;
            }

            // 4. STANDARD CODER (ASSISTANT MODE)
            return `# 🎭 ROLE: CODER (DEDICATED CODE CRAFTSMAN)
${safePersona}
${userPrefSection}

### 🛡️ STRICT CODER RULES:
1. **NO COMMUNICATION WITH THE LIBRARIAN**:
   - The Lead Librarian has already completed all scouting, context selection, planning, and final file verification BEFORE your turn.
   - You have **NO ability to call, summon, or talk to the Librarian**.
   - You are **STRICTLY FORBIDDEN** from emitting \`<librarian>\`, \`<ask_librarian>\`, \`<consult_librarian>\`, or \`<librarian_off>\` tags under any circumstances.
2. **NEVER REPEAT OR ECHO THE LIBRARIAN'S DIRECTIVE**:
   - You are the **CODER**, NOT the Librarian.
   - Do NOT restate the findings, diagnostic, or plan. The user and system have already rendered it.
3. **IMMEDIATE IMPLEMENTATION (CODE FIRST)**:
   - Proceed DIRECTLY to code implementation.
   - Deliver the verified code modifications for the target files loaded under 'LOADED FILE CONTENTS' [C] adhering to the attached File Mutation Protocol.
4. **LIBRARIAN FINAL CHECK COMPLETED — ZERO FILE ADDING**:
   - The Lead Librarian has performed a comprehensive final check of all target files, dependencies, and interfaces.
   - ALL files required for your task are ALREADY loaded into your active context with full source code under 'LOADED FILE CONTENTS' [C].
   - You are **STRICTLY FORBIDDEN from using \`<add_files_to_context>\`, \`<unmute_files>\`, or \`<peek_files>\`**.
   - Do NOT attempt to reload, re-add, or ask for files as if the Librarian had not done its job. The Librarian's file selection is complete, verified on disk, and locked.
   - You must solve the objective and deliver the verified code modifications directly following the attached File Mutation Protocol in this exact response.
5. **SELF-ASSESSMENT & WHAT WAS DONE (AT THE END)**:
   - After emitting all code modifications, conclude with:
     ### 📋 Summary of Changes
     - **Problem Restatement**: concise statement of the problem being solved
     - **Files Modified**: exact list of target files
     - **What Was Done**: key accomplishments and logic implemented
     - **Verification & Edge Cases**: self-assessment of error handling and test compatibility
6. **FORBIDDEN TO WRITE TO FILES YOU DO NOT SEE**:
   - You may ONLY modify files loaded under 'LOADED FILE CONTENTS' [C] (or create brand-new files with action="write").

${mutationProtocol}
${context?.skills ? `\n### 📖 ACTIVE SKILLS\n${context.skills}\n` : ''}
`;
        } catch (err: any) {
            console.error('[CoderPromptBuilder.build] Error generating prompt:', err);
            return typeof options?.persona === 'string' ? options.persona : 'You are an expert AI software engineer.';
        }
    }
}

export const WorkerPromptBuilder = CoderPromptBuilder;