import * as vscode from 'vscode';
import * as os from 'os';
import { DiscussionCapabilities, getAvailableShells, ResponseProfile, SYSTEM_RESPONSE_PROFILES } from './utils';

export class PromptTemplates {
    
    private static getFormatInstructions(capabilities?: DiscussionCapabilities, forceFullCodeSetting?: boolean): string {
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
### 🚦 CODE GENERATION DECISION LOGIC
1. **NEW FILE**: You MUST use the **FULL FILE** format.
2. **HUGE CHANGES (>50%)**: If you are changing more than 50% of the file, use the **FULL FILE** format.
3. **STANDARD EDITS (<50%)**: For most edits, you MUST use the ${partialFormat.toUpperCase()} format. Do NOT output the full file for small changes.

### ⚡ FORMAT: ${partialFormat.toUpperCase()} (For Standard Edits)
Use this for modifications to existing files.
[Specific ${partialFormat.toUpperCase()} rules will follow below]

### 📄 FORMAT: FULL FILE CONTENT (For Heavy Modifications Only)
If changes are extensive, use:
\`\`\`python:src/utils.py
[FULL CODE HERE]
\`\`\`
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
3. **CONTEXT**: Include 3-4 lines of unchanged context before and after the modification in BOTH blocks.
4. **CONTAINMENT**: All code changes must be *inside* the \`=======\` and \`>>>>>>> REPLACE\` markers. Content outside is ignored.
5. **NO ELLIPSIS**: Do not use "..." to skip code in the SEARCH block.
6. **NO LINE NUMBERS**: Do not include line numbers.
7. **ATOMIC EDITS (CRITICAL)**: **NEVER** build a single large block for multiple changes. Split your edits into many small, highly specific SEARCH/REPLACE blocks. A block should ideally target a single function, variable, or logic branch. This ensures maximum matching precision.
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

    public static async getSystemPrompt(
        promptType: 'chat' | 'agent' | 'inspector' | 'commit' | 'surgical_agent',
        capabilities?: DiscussionCapabilities,
        customPersonaContent?: string,
        memory?: string,
        forceFullCode?: boolean,
        context?: { tree: string, files: string, skills: string }
    ): Promise<string> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        
        const configProfiles = config.get<ResponseProfile[]>('responseProfiles') ||[];
        const activeProfileId = capabilities?.responseProfileId || config.get<string>('defaultResponseProfileId') || 'balanced';
        
        let activeProfile = SYSTEM_RESPONSE_PROFILES.find(p => p.id === activeProfileId);
        if (!activeProfile) activeProfile = configProfiles.find(p => p.id === activeProfileId);
        if (!activeProfile) activeProfile = SYSTEM_RESPONSE_PROFILES[0];

        let persona = customPersonaContent || config.get<string>(
            promptType === 'chat' ? 'chatPersona' :
            promptType === 'agent' ? 'agentPersona' :
            promptType === 'inspector' ? 'codeInspectorPersona' :
            'commitMessagePersona'
        ) || "You are an expert software engineer.";

        const formatting = this.getFormatInstructions(capabilities, forceFullCode);
        const shells = await getAvailableShells();

        const prefix = (activeProfile && activeProfile.prefix) ? activeProfile.prefix + "\n" : "";

        const skillsAuthority = context?.skills ? `
### 📖 SKILLS AUTHORITY PROTOCOL
Information provided in the **Active Skills & Protocols** section is your **SOURCE OF TRUTH**.
1. **NO HALLUCINATIONS**: If a skill defines an API (e.g. safe_store, moltbook), you MUST use the exact parameters, methods, and endpoints defined in that skill.
2. **OVERRIDE**: Skill documentation overrides your general training data. If your internal knowledge contradicts a skill, the skill is correct.
3. **STRICT ADHERENCE**: Follow all coding patterns and security rules defined in the skills perfectly.
` : '';

        if (promptType === 'surgical_agent') {
            return `${prefix}# 🎭 ROLE: SURGICAL REPAIR ORCHESTRATOR
You are a senior debugger. Your goal is to fix specific errors in a file using the **AIDER SEARCH/REPLACE** format.

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

### 🚷 ANTI-HALLUCINATION & CONTEXT BOUNDARIES
1. **NO BLIND EDITS**: You are FORBIDDEN from generating code blocks (edit/create) for files that are NOT present in the "File Contents" section above. If you need to modify a file that is only visible in the Tree, you MUST ask the user to add it to context first (or use \`read_file\` if available).
2. **NO BLIND IMPORTS**: Do not assume a class, function, or variable exists in a file you cannot see. You must verify exports by reading the file before importing.
3. **EXACT PATHS**: Always use the exact file paths as they appear in the "Project Structure" tree. Do not guess paths or hallucinate files that do not exist in the tree.
4. **SUBPROJECTS**: If working in a workspace with multiple subprojects, pay strict attention to the root directories shown in the file tree.
5. **READ BEFORE WRITE**: Always read the current state of a file before attempting to modify it to ensure search blocks match exactly.

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

${formatting}
`;
    }
}