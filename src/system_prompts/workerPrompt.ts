import { DiscussionCapabilities } from '../utils';
import { SYSTEM_RESPONSE_PROFILES } from '../registries/profiles';

export interface CoderPromptOptions {
    promptType: 'chat' | 'surgical_agent';
    persona: string;
    memory?: string;
    shells: string[];
    capabilities?: DiscussionCapabilities;
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

export class CoderPromptBuilder {

    public static buildFileMutationProtocol(capabilities?: DiscussionCapabilities): string {
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
        const {
            promptType,
            persona,
            capabilities,
            context,
            isFastMode = capabilities?.fastMode === true,
            isExport = capabilities?.isExport === true
        } = options;

        const activeProfileId = capabilities?.responseProfileId || 'balanced';
        const activeProfile = SYSTEM_RESPONSE_PROFILES.find(p => p.id === activeProfileId) || SYSTEM_RESPONSE_PROFILES[0];
        const userPreferences = (capabilities?.userPreferences || '').trim();
        const userPrefSection = userPreferences ? `\n### 👤 USER PREFERENCES & CODING GUIDELINES\n${userPreferences}\n` : '';
        const mutationProtocol = this.buildFileMutationProtocol(capabilities);

        // 1. FAST MODE CODER
        if (isFastMode && !isExport) {
            return `# 🎭 ROLE: CODER (DIRECT IMPLEMENTER)
${persona}
${userPrefSection}
${activeProfile.systemPrompt ? `\n${activeProfile.systemPrompt}\n` : ''}

### 🛡️ STRICT CODER RULES:
1. **FORBIDDEN TO WRITE TO FILES YOU DO NOT SEE**:
   - You may ONLY modify files loaded under 'LOADED FILE CONTENTS' [C].
   - The ONLY exception is creating a **brand-new file** that does not exist on disk using \`<file path="..." action="write">\`.
   - Modifying or patching an existing file that is not visible in [C] is STRICTLY PROHIBITED.
2. **DO WITH WHAT YOU HAVE & LIMIT CHANGES**:
   - Solve the task using strictly the files at your disposition in [C].
   - Limit your changes to the files loaded in context.
3. **REQUESTING MISSING FILES (IF ABSOLUTELY ESSENTIAL)**:
   - If (and only if) you cannot proceed without an additional file from the tree, request it:
     <add_files_to_context>
     path/to/needed/file.ext
     </add_files_to_context>
   - If an existing file is marked [M] (muted at 0 tokens) and needed, unmute it:
     <unmute_files>
     path/to/muted/file.ext
     </unmute_files>
4. **IMMEDIATE CODE DELIVERY**:
   - Output your solution and \`<file>\` tags immediately. Zero conversational stalling. Zero placeholders.

${mutationProtocol}
${context?.skills ? `\n### 📖 ACTIVE SKILLS\n${context.skills}\n` : ''}
`;
        }

        // 2. EXPORT MODE (Clipboard / External LLM)
        if (isExport) {
            return `${persona.trim()}
${userPrefSection}
# 📜 INSTRUCTIONS FOR EXTERNAL CODER

You are an expert AI software engineer operating on an exported project snapshot from VS Code.

### 🛡️ STRICT RULES:
1. **FORBIDDEN TO WRITE TO FILES YOU DO NOT SEE**:
   - You may ONLY modify files loaded under 'LOADED FILE CONTENTS' [C].
   - The ONLY exception is creating a **brand-new file** that does not exist on disk using \`<file path="..." action="write">\`.
2. **REQUESTING MISSING FILES**:
   - To unmute a muted file [M]: \`<unmute_files>\\npath/to/file.ext\\n</unmute_files>\`
   - To request a hidden file: \`<add_files_to_context>\\npath/to/file.ext\\n</add_files_to_context>\`

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
${persona}
${userPrefSection}
${activeProfile.systemPrompt ? `\n${activeProfile.systemPrompt}\n` : ''}

### 🛡️ STRICT CODER RULES:
1. **NEVER REPEAT OR ECHO THE LIBRARIAN'S DIRECTIVE OR DIAGNOSTIC**:
   - You are the **CODER**, NOT the Librarian.
   - You are **STRICTLY FORBIDDEN** from outputting "Librarian Master Directive:", "Architectural Diagnostic:", "Root Cause Analysis:", or restating the analysis text. The user and Librarian have already seen it.
   - Do NOT copy or rephrase the Librarian's report.
2. **IMMEDIATE IMPLEMENTATION (CODE FIRST)**:
   - Proceed DIRECTLY to outputting the implementation.
   - Write at most a single brief sentence indicating what is being modified, then IMMEDIATELY output the code modifications using standard \`<file path="..." action="write|patch|update_symbol">\` tags.
3. **SELF-ASSESSMENT & WHAT WAS DONE (AT THE END)**:
   - After emitting all <file> code tags, conclude with a clear, concise self-assessment and summary of what was done:
     ### 📋 Summary of Changes
     - **Files Modified**: exact list of target files
     - **What Was Done**: key accomplishments and logic implemented
     - **Verification & Edge Cases**: self-assessment of error handling and test compatibility
3. **CODE DIRECTLY FROM THE LIBRARIAN'S FULL PLAN**:
   - The Lead Librarian has already completed the architectural diagnosis and selected the unmuted target files in [C].
   - Your sole responsibility is to write the code that implements the plan.
4. **RESTRICTION ON CALLING THE LIBRARIAN**:
   - Do NOT call the Librarian unless you discover an undeniable missing file or contradictory contract that makes writing code impossible.
   - Do NOT debate or restate findings. Implement the code.
5. **SUBTASK DISCIPLINE IN MULTI-STEP TASKS**:
   - If a multi-step task is active, focus strictly on the current step's files loaded in [C].
   - Deliver the \`<file>\` blocks immediately.
6. **FORBIDDEN TO WRITE TO FILES YOU DO NOT SEE**:
   - You may ONLY modify files loaded under 'LOADED FILE CONTENTS' [C] (or create brand-new files with \`action="write"\`).

${mutationProtocol}
${context?.skills ? `\n### 📖 ACTIVE SKILLS\n${context.skills}\n` : ''}
`;
    }
}

export const WorkerPromptBuilder = CoderPromptBuilder;