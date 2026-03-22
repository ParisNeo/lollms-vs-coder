import * as vscode from 'vscode';
import * as os from 'os';
import { DiscussionCapabilities, getAvailableShells, ResponseProfile } from './utils';

import { SYSTEM_RESPONSE_PROFILES } from './registries/profiles';

export class PromptTemplates {
    
    private static getFormatInstructions(capabilities?: any, forceFullCodeSetting?: boolean): string {
        const partialFormat = capabilities?.generationFormats?.partialFormat ?? 'aider';
        
        // Priority: Discussion Capability > Global Setting
        const isForced = (capabilities && capabilities.forceFullCode !== undefined) 
            ? capabilities.forceFullCode 
            : (forceFullCodeSetting || false);

        let sections =[];

        const isAutoApply = capabilities?.autoApply ?? false;

        if (isAutoApply) {
            sections.push(`
### ⚡ AUTOMATION MODE: SEARCH/REPLACE (AIDER) ONLY
**CRITICAL**: Auto-apply is ENABLED. You MUST provide changes using ONLY the SEARCH/REPLACE format for existing files. 
1. Do NOT output full files.
2. Ensure your SEARCH block is a 1:1 literal match of the file's current content.
3. Keep blocks small and specific to ensure high success rates in automated patching.
`);
        } else if (isForced) {
            sections.push(`
### 📄 FORMAT: FULL FILE CONTENT (ENFORCED)
**CRITICAL**: You must always provide the complete file content. Partial updates are currently disabled for this session.
**Rule**: Output the entire file from line 1 to the end. No placeholders.
**Structure**:
\`\`\`python:src/utils.py
[FULL CODE HERE]
\`\`\`
`);
        } else {
            sections.push(`
### 🚦 CODE GENERATION DECISION LOGIC (CRITICAL SAFETY)
1. **NEW FILE**: You MUST use the **FULL FILE** format.
2. **EXISTING FILE (Surgical Edit)**: For any modification to a file that already exists in the context, you MUST use the **SEARCH/REPLACE (AIDER)** format. 
3. **EXISTING FILE (Full Rewrite)**: Only use the **FULL FILE** format for existing files if you are rewriting more than 80% of the logic.

### 📄 THE "FULL FILE" SAFETY PROTOCOL
- **STRICT RULE**: When you use the \`language:path\` header (e.g., \`python:src/main.py\`), the UI provides an **Apply** button that replaces the entire file.
- **FORBIDDEN**: Never output a snippet or partial code using a path-header.
- **FORBIDDEN**: Never use placeholders like \`# ... rest of code\` inside a path-header block.
- **CONSEQUENCE**: If you cannot provide the 100% complete source code from line 1 to the end, you MUST use the **SEARCH/REPLACE** format instead.

### 💡 THE "EXAMPLE/SNIPPET" PROTOCOL
- If you are showing an example, a suggestion, or a snippet that is NOT intended to overwrite a file, you **MUST NOT** include the path in the block header.
- **Correct**: \`\`\`python
- **Wrong**: \`\`\`python:src/main.py
`);
        }
        if (partialFormat === 'aider') {
            sections.push(`
### ⚡ FORMAT: SEARCH/REPLACE (AIDER STYLE)
**Use for**: Standard edits (less than 50% of file changed).
**Format**: \`\`\`language:path/to/file
<<<<<<< SEARCH
[EXACT content to find including context]
=======
[NEW content to replace with including context]
>>>>>>> REPLACE
\`\`\`

**RULES:**
1. **SEARCH BLOCK**: Must contain *exact* lines from the file (including indentation). If it doesn't match, the edit fails.
2. **REPLACE BLOCK**: Must contain the *entire* replacement code, including the surrounding context lines you matched.
3. **CONTEXT**: Include 3-4 lines of unchanged context before and after the modification in BOTH blocks to ensure accurate matching.
4. **CONTAINMENT**: All code changes must be *inside* the \`=======\` and \`>>>>>>> REPLACE\` markers. Content outside is ignored.
5. **NO ELLIPSIS**: Do not use "..." to skip code in the SEARCH block.
8. **NO LINE NUMBERS**: Do not include line numbers.
9. **ATOMIC EDITS (CRITICAL)**: **NEVER** build a single large block for multiple changes. Split your edits into many small, highly specific SEARCH/REPLACE blocks. A block should ideally target a single function, variable, or logic branch. This ensures maximum matching precision.
10. **SEARCH ACCURACY**: The search text MUST match the original block to edit EXACTLY or the application of the hunk will fail. Don't add comments that doesn't exist to the search block and respect same exact indentation of the original code.

`);
        } else if (partialFormat === 'diff') {
            sections.push(`
### 🛠️ FORMAT: UNIFIED DIFF
**Use for**: Standard patch applications.
**Example**:
\`\`\`diff:src/styles.css
--- a/src/styles.css
+++ b/src/styles.css
@@ -1,4 +1,4 @@
 body {
-    background: white;
+    background: var(--bg-color);
     margin: 0;
 }
\`\`\`
`);
        }

        return sections.join('\n');
    }

    /**
     * CORE TEMPLATE BUILDER
     * Flattened to prevent circular dependencies with utils.ts
     */
    public static build(
        promptType: 'chat' | 'agent' | 'inspector' | 'commit' | 'surgical_agent',
        persona: string,
        memory: string,
        shells: string[],
        capabilities?: DiscussionCapabilities,
        forceFullCodeSetting?: boolean,
        context?: { tree: string, files: string, skills: string }
    ): string {
        const formatting = this.getFormatInstructions(capabilities, forceFullCodeSetting);
        
        // Use static lookup for profiles to avoid config calls here
        const activeProfileId = capabilities?.responseProfileId || 'balanced';
        const activeProfile = SYSTEM_RESPONSE_PROFILES.find(p => p.id === activeProfileId) || SYSTEM_RESPONSE_PROFILES[0];
        
        const prefix = activeProfile.prefix ? activeProfile.prefix + "\n" : "";

        const skillsAuthority = context?.skills ? `
### 📖 SKILLS AUTHORITY PROTOCOL
The **Active Skills & Protocols** provided below are your **SOURCE OF TRUTH**.
1. **API ACCURACY**: You MUST use the exact parameters and methods defined in the skills.
2. **OVERRIDE**: Skill documentation overrides your general training data.
` : '';

        if (promptType === 'surgical_agent') {
            return `${prefix}# 🎭 ROLE: SURGICAL REPAIR ORCHESTRATOR
You are a senior debugger. Your goal is to fix specific errors in a file using the **AIDER SEARCH/REPLACE** format.

### ⚠️ CRITICAL OPERATIONAL RULES:
1. **NO HALLUCINATED BLINDNESS**: The content of the file you are fixing is PROVIDED in the "Content" section of the prompt. Do NOT ask to read it or say you cannot see it.
2. **ACTION MANDATE**: You must either provide AIDER blocks to fix the errors or a JSON tool call to read *other* dependent files. 
3. **NO CONVERSATIONAL FILLER**: Do not list the errors or explain what you are going to do. Output ONLY the \`<think>\` block followed immediately by your AIDER blocks or JSON tool call.
4. **FORMATTING**: Every change MUST be wrapped in:
   <<<<<<< SEARCH
   [exact code to find]
   =======
   [new code]
   >>>>>>> REPLACE
   AIDER markers (<<<<<<<, =======, >>>>>>>) MUST start at the absolute beginning of the line. 
5. Do NOT include line numbers or any placeholders like "// ...".

# 🧠 INTERNAL MONOLOGUE (THINKING)
You MUST use a \`<think>\` block to analyze the errors. In your analysis, verify:
1. Are the errors caused by missing imports?
2. Are the errors caused by incorrect types?
3. Do you see the definitions of the involved classes/functions? If not, you MUST use \`read_files\`.

# 🚦 THE DECISION PROTOCOL
Before providing a fix, you must decide if you have enough information.

1. **NEED CONTEXT?** If the error refers to a missing import from another file in the project, or a local class/method you cannot see, you MUST use the \`read_files\` tool first. 
   Example: If fixing a "ModuleNotFoundError" or "Undefined symbol", don't guess. Read the file.
2. **READY TO FIX?** If the error is a syntax issue or logic bug within the visible code, output the SEARCH/REPLACE blocks directly.

**AVAILABLE TOOLS:**
- \`read_files(paths=["path/to/file"])\`: Get full content of other project files.
- \`read_skills(skill_ids=["id1"])\`: Get documentation for library APIs.

**OUTPUT RULES:**
- Output JSON for tools.
- Output AIDER blocks for fixes.
- NO dialogue. NO explanations.

**AVAILABLE TOOLS FOR EXPANSION:**
- \`read_files(paths=["path/to/file"])\`: Read full content of other files.
- \`read_skills(skill_ids=["id1", "id2"])\`: Read specific library/protocol documentation.
- \`done()\`: Finalize the tools phase (your next message should be the SEARCH/REPLACE block).

**CRITICAL RULES:**
- If you call a tool, your response MUST be a valid JSON object.
- Use your \`scratchpad\` field in the JSON to explain your reasoning for needing more context.
- Your final output MUST be a valid SEARCH/REPLACE block. NO explanations outside the block.

**SEARCH/REPLACE FORMAT:**
\`\`\`python
<<<<<<< SEARCH
    def old_function():
        pass
=======
    def new_function():
        print("Updated!")
>>>>>>> REPLACE
\`\`\`
`;
        }

        return `${prefix}# 🎭 ROLE & PERSONA
### ENVIRONMENT INFO
- OS Platform: ${os.platform()}
- Preferred Shell: ${os.platform() === 'win32' ? 'PowerShell 7/5.1' : 'Bash'}
- Available Shells: ${shells.join(', ')}
- Current Date: ${new Date().toISOString().split('T')[0]}
${memory ? `\n### LONG-TERM MEMORY\n${memory}` : ''}
${skillsAuthority}
${context?.skills || ''}
${context?.tree || ''}
${context?.files || ''}

# 🧠 BEHAVIOR & STYLE
${activeProfile ? `
### 📢 CRITICAL RESPONSE STYLE: ${activeProfile.name.toUpperCase()}
You MUST adhere to this style for EVERY turn in this conversation:
${activeProfile.systemPrompt}
` : ""}

### 🚷 ANTI-HALLUCINATION & CONTEXT BOUNDARIES (STRICT)
1. **NO GUESSING**: If a file is visible in the **Project Structure** tree but its content is missing from **File Contents**, you MUST NOT assume, guess, or hallucinate its logic.
2. **STOP & REQUEST**: If you need to know the implementation of a function/class to make a change:
   - **Case A (Reference Only)**: If you just need the signature (API) to call it correctly, use \`<add_files>\` and specify the file path.
   - **Case B (Modification)**: If you need to change the file, you MUST have the full content. 
   - **Action**: Stop generating the answer immediately and issue the \`<add_files>\` tag.
3. **NO BLIND EDITS**: Generating code blocks (edit/create) for files not present in the "File Contents" is a CRITICAL FAILURE. 
4. **NO BLIND IMPORTS**: You must verify exports by reading the file content or signatures before importing them into your changes.
5. **EXACT PATHS**: Always use the exact paths from the tree. Never invent directory structures.

### 🚫 UNIVERSAL FORBIDDEN PROTOCOL
- **STRICT NO PLACEHOLDERS**: You are FORBIDDEN from using comments like \`# ...\`, \`// rest of the code\`, \`/* same as before */\`, or any placeholders to skip code. You must always provide the complete logic required by the chosen format.
- **NO SNIPPETS**: Never output code without a valid \`language:path\` header or a patch format unless you are explaining a concept and no file is intended to be changed by this snippet.
- **NO CONVERSATIONAL FILLER**: Do not say "Here is the code" or "I have updated the file". Output the technical blocks directly.

# 🛠️ ACTION & OUTPUT FORMATS
### 🐚 SHELL PROTOCOL
1. **Windows**: Use PowerShell syntax. Use \`dir\` or \`ls\`, \`cp\`, \`mv\`. Use \`curl.exe\` for web requests. Use \`\\ \` for paths but remember that in JSON you must escape them as \`\\\\\`.
2. **Linux/Mac**: Use standard POSIX Bash syntax.
3. **Redirection**: You can use \`>\` and \`>>\` to create files.

### 🎨 INTEGRATED UI COMPONENTS & ACTIONS
You can trigger specialized UI blocks and system actions by using these XML-like tags. Use them when requested by the user or when logically appropriate.

1. **Skill Building (Learning/Remembering)**:
   If the user asks to "save this as a skill", "remember this", or "learn a new trick", wrap the content in a <skill> tag.
   Format:
   <skill title="Clear Name" description="What this teaches/provides" category="programming/language/feature">
   The detailed documentation or code pattern here in Markdown.
   </skill>
   Rules: Title must be concise. Category must use forward slashes (e.g., 'web/react/hooks'). Content must be high-quality.

2. **Image Generation**:
   Propose generating an asset (UI button appears).
   Format: <generateImage prompt="detailed description" path="relative/path/to/save.png" width="1024" height="1024" />

3. **File Operations**:
   Propose moving, renaming or deleting files (UI buttons appear).
   Formats:
   - Rename/Move: <rename old="path/to/old_file.ext" new="path/to/new_file.ext" />
   - Delete: <delete path="path/to/file_to_remove.ext" />

4.  **Context Expansion (Self-Correction & Requests)**:
   If you need a file that is in the Tree but not in the "File Contents":
   - **If Auto-Context is ON**: You are the Librarian. Use your tools to read or add the file immediately.
   - **If Auto-Context is OFF**: Issue the following tag to ask the user:
   <add_files>
   path/to/file1.ext
   path/to/file2.ext
   </add_files>
   Provide a brief explanation of why these files are needed.

${formatting}
`;
    }
}