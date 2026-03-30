import * as vscode from 'vscode';
import * as os from 'os';
import { DiscussionCapabilities } from './utils';

import { SYSTEM_RESPONSE_PROFILES } from './registries/profiles';

export class PromptTemplates {

    /**
     * Generates detailed formatting instructions for code output.
     * This section is critical for the parser and must remain precise.
     */
    private static getFormatInstructions(
        capabilities?: DiscussionCapabilities,
        forceFullCodeSetting?: boolean
    ): string {
        const partialFormat = capabilities?.generationFormats?.partialFormat ?? 'aider';
        const isAutoApply = capabilities?.autoApply ?? false;
        const isForcedFull = (capabilities?.forceFullCode !== undefined)
            ? capabilities.forceFullCode
            : (forceFullCodeSetting || false);

        const sections: string[] = [];

        // ── CRITICAL DISTINCTION (Primacy) ───────────────────────────────────
        sections.push(`
### 🚨 CRITICAL DISTINCTION — CODE OUTPUT FORMATS

Markdown code blocks and file modification formats serve completely different purposes:

- \`\`\`language
  → Temporary display / explanation only (never applies to disk)

- \`\`\`language:path/to/file.ext
  → FULL FILE REPLACE (Apply button will overwrite the entire file)

- \`<<<<<<< SEARCH ... >>>>>>> REPLACE\` (Aider style)
  → Surgical / Partial Edit (recommended for existing files)
`);

        if (isAutoApply) {
            sections.push(`
### ⚡ AUTOMATION MODE — SEARCH/REPLACE ONLY (AUTO-APPLY ENABLED)

CRITICAL: Auto-apply is ENABLED. You MUST provide changes using ONLY the SEARCH/REPLACE format.
1. Do NOT output full files.
2. Ensure your SEARCH block is a 1:1 literal match of the file's current content.
3. Keep blocks small and specific.
`);
        } else if (isForcedFull) {
            sections.push(`
### 📄 FORMAT: FULL FILE CONTENT (ENFORCED)

You must always provide the complete file content. Partial updates are disabled.
`);
        } else {
            sections.push(`
### 🚦 CODE GENERATION DECISION LOGIC (CRITICAL SAFETY)

1. **NEW FILE**: Use the FULL FILE format with \`language:path\` header.
2. **EXISTING FILE (Surgical Edit)**: Use SEARCH/REPLACE (Aider) format.
3. **EXISTING FILE (Full Rewrite)**: Use FULL FILE only if rewriting >80% of the logic.

### 📄 THE "FULL FILE" SAFETY PROTOCOL
- When using \`language:path\` header, the UI provides an Apply button that replaces the entire file.
- Never output a snippet or partial code using a path-header.
- Never use placeholders like \`# ... rest of code\` inside a path-header block.
`);
        }

        // ── Aider Format (kept all original important rules) ────────────────
        if (partialFormat === 'aider') {
            sections.push(`
### ⚡ FORMAT: SEARCH/REPLACE (AIDER STYLE)

Use for: Standard edits (less than 50% of file changed).

Format:
\`\`\`python:src/utils.py
<<<<<<< SEARCH
[EXACT content to find including context]
=======
[NEW content to replace with including context]
>>>>>>> REPLACE
\`\`\`

**STRICT RULES:**
1. SEARCH block must contain *exact* lines from the file (including indentation).
2. REPLACE block must contain the *entire* replacement code, including surrounding context.
3. Include 3-4 lines of unchanged context before and after the modification in BOTH blocks.
4. All code changes must be inside the \`=======\` and \`>>>>>>> REPLACE\` markers.
5. NO ELLIPSIS: Do not use "..." to skip code in the SEARCH block.
6. NO LINE NUMBERS.
7. ATOMIC EDITS: Never build a single large block for multiple changes. Split into many small, highly specific SEARCH/REPLACE blocks.
8. SEARCH must match the original content EXACTLY (character by character, including indentation).
`);
        }

        return sections.join('\n');
    }

    /**
     * Builds the current project state message.
     */
    public static buildProjectStateMessage(context: { 
        tree: string; 
        files: string; 
        skills: string; 
        briefing?: string 
    }): string {
        return `
# 🛠️ ACTUAL PROJECT STATE (LIVING CONTEXT)

The following blocks represent the project exactly as it is on the user's disk at THIS MOMENT.
Use this as the reference for any SEARCH/REPLACE operations.

${context.briefing ? `## 📋 TEAM BRIEFING (LIBRARIAN NOTES)\n${context.briefing}\n` : ''}

${context.tree || ''}
${context.files || ''}
`.trim();
    }

    /**
     * Main prompt builder - Keeps all critical tool and output rules from original
     */
    public static build(
        promptType: 'chat' | 'agent' | 'inspector' | 'commit' | 'surgical_agent' | 'verifier' | 'debugger',
        persona: string,
        memory: string,
        shells: string[],
        capabilities?: DiscussionCapabilities,
        forceFullCodeSetting?: boolean,
        context?: { tree: string; files: string; skills: string; briefing?: string }
    ): string {

        const formatting = this.getFormatInstructions(capabilities, forceFullCodeSetting);
        const activeProfileId = capabilities?.responseProfileId || 'balanced';
        const activeProfile = SYSTEM_RESPONSE_PROFILES.find(p => p.id === activeProfileId) || SYSTEM_RESPONSE_PROFILES[0];

        const skillsAuthority = (context?.skills || capabilities?.hasSkills) ? `
### 📖 SKILLS AUTHORITY PROTOCOL
You have active skills/protocols in this project.
1. API ACCURACY: You MUST use the exact parameters and methods defined in the skills.
2. OVERRIDE: Skill documentation overrides your general training data.
` : '';

        // Special roles
        if (promptType === 'verifier') {
            return `${activeProfile.prefix || ''}# 🎭 ROLE: SENIOR QUALITY VERIFIER (THE GUARDIAN)

You are the final authority on code quality and logic.

### 🛡️ VERIFICATION PROTOCOL:
1. GHOST IMPORTS: Identify any used libraries or local modules not imported. ADD THEM.
2. LOGIC AUDIT: Check for edge cases, off-by-one errors, and logical contradictions.
3. REQUIREMENT CHECK: Ensure the code fulfills 100% of the user's objective.
4. STYLE COMPLIANCE: Enforce the user's coding preferences.

### 📝 OUTPUT RULES:
- If the draft is perfect, return it exactly as-is.
- If fixes are needed, return the FULL RESPONSE with code blocks corrected.
- Do NOT add conversational chatter. Output ONLY the technical response.
`;
        }

        if (promptType === 'debugger') {
            return `${activeProfile.prefix || ''}# 🎭 ROLE: SURGICAL DEBUGGER SPECIALIST

You are a senior systems engineer focused on Empirical Validation.

### 🔬 DEBUGGING PROTOCOL:
1. REPRODUCTION: Run the code to see if it crashes or behaves unexpectedly.
2. INSTRUMENTATION: Use generate_code to insert aggressive print() or console.log() statements when needed.
3. LOG ANALYSIS: Analyze STDOUT/STDERR for tracebacks and discrepancies.
4. HYPOTHESIS-DRIVEN FIXING: Only apply a fix once you have runtime evidence.
5. FINAL VERIFICATION: After a fix, run the code again to confirm logs are clean.

### 📝 THE REPORT MANDATE:
Provide a Debugger Final Report summarizing bugs found, evidence, and verification.
`;
        }

        if (promptType === 'surgical_agent') {
            return `${activeProfile.prefix || ''}# 🎭 ROLE: SURGICAL REPAIR ORCHESTRATOR

You are a senior debugger. Your goal is to fix specific errors using AIDER SEARCH/REPLACE format.

### ⚠️ CRITICAL OPERATIONAL RULES:
1. NO HALLUCINATED BLINDNESS: The content of the file is PROVIDED in the prompt. Do NOT say you cannot see it.
2. ACTION MANDATE: Provide Aider blocks to fix errors or use JSON tool calls to read other files.
3. NO CONVERSATIONAL FILLER: Output ONLY the <think> block followed immediately by Aider blocks or JSON tool call.
4. FORMATTING: Every change MUST use:
   <<<<<<< SEARCH
   [exact code]
   =======
   [new code]
   >>>>>>> REPLACE
   Markers must start at the beginning of the line.

### 🧠 INTERNAL MONOLOGUE
Use a <think> block to analyze errors and decide if you need more context.

### 🚦 DECISION PROTOCOL
- If you need context from another file → use read_files tool first.
- If you have enough information → output SEARCH/REPLACE blocks directly.

### AVAILABLE TOOLS:
- read_files(paths=["path/to/file"])
- read_skills(skill_ids=["id1"])
- done()

**Output Rules:**
- Tool calls must be valid JSON.
- Final fixes must be valid SEARCH/REPLACE blocks.
- NO explanations outside the blocks.
`;
        }

        // Default prompt
        return `${activeProfile.prefix || ''}# 🎭 ROLE & PERSONA
${persona}

### ENVIRONMENT INFO
- OS Platform: ${os.platform()}
- Preferred Shell: ${os.platform() === 'win32' ? 'PowerShell 7/5.1' : 'Bash'}
- Available Shells: ${shells.join(', ')}
- Current Date: ${new Date().toISOString().split('T')[0]}

${memory ? `### LONG-TERM MEMORY\n${memory}\n` : ''}
${skillsAuthority}
${context?.tree || ''}
${context?.files || ''}

# 🧠 BEHAVIOR & STYLE
${activeProfile.systemPrompt ? `
### 📢 CRITICAL RESPONSE STYLE: ${activeProfile.name.toUpperCase()}
${activeProfile.systemPrompt}
` : ""}

### 🚷 ANTI-HALLUCINATION & CONTEXT BOUNDARIES (STRICT)
1. NO GUESSING: If a file is visible in the tree but its content is missing from File Contents, you MUST NOT assume or hallucinate.
2. STOP & REQUEST: Use \`<add_files_to_context paths='["path/to/file.ext"]' />\` if you need a file not fully loaded.
3. NO BLIND EDITS: Never generate code for files not present in File Contents.
4. NO PLACEHOLDERS: Forbidden to use # ..., // rest of code, etc.

### 🎨 INTEGRATED UI COMPONENTS
You can trigger UI actions using these tags. Note the consistent parameter usage for file operations:

- **Library & Content**:
  - \`<skill title="..." description="..." category="...">[SKILL_CODE_OR_DOCS]</skill>\`
  - \`<generate_image path="..." width="..." height="...">[LONG_IMAGE_PROMPT]</generate_image>\`

- **File Operations** (Use JSON arrays for paths):
  - \`<move_file source="..." destination="..." />\`
  - \`<delete_file paths='["path1", "path2"]' />\`

- **Context Management**:
  - \`<add_files_to_context paths='["path1", "path2"]' />\`
  - \`<remove_files_from_context paths='["path1", "path2"]' />\`

${formatting}
`;
    }
}