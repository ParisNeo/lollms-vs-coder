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
        const isForcedFull = capabilities?.forceFullCode === true || forceFullCodeSetting === true;

        const sections: string[] = [];

        // ── ZERO-PLACEHOLDER MANDATE (CRITICAL RED-LINE) ────────────────────────
                sections.push(`
        # 🛑 THE ZERO-PLACEHOLDER MANDATE (CRITICAL - ZERO-TOLERANCE)
        You are **STRICTLY FORBIDDEN** from using any form of placeholders, ellipses, or comments to skip code (e.g., \`# (The body of this class remains logically identical to...)\`, \`// ... rest of code\`, \`# existing imports here\`, \`/* same as above */\`, or \`...\`).
        - **NO EXCEPTIONS**: Every single character that belongs in the file or the replacement block MUST be written explicitly from line 1 to the end.
        - **CONSEQUENCE**: If you use any placeholders, code-skipping comments, or ellipses, the user's file will be corrupted, the build will break, and the mission will fail immediately. 
        - **RULE**: If you are writing a new file, you MUST write out 100% of the code explicitly. Do NOT summarize or use comments to represent existing code. If you are duplicating/moving an existing file to a new path then use the copy/move tool instead of manually writing it.

        # 🚫 READ-ONLY ARTIFACT MANDATE (DOCUMENTS & BINARIES)
        - Files with extensions like \`.pdf\`, \`.docx\`, \`.xlsx\`, \`.xls\`, \`.pptx\`, \`.msg\`, \`.odt\`, \`.ipynb\`, \`.png\`, \`.jpg\`, \`.bin\` are **READ-ONLY EXTRACTED TEXT OR MULTIMODAL ARTIFACTS**.
        - You are **STRICTLY FORBIDDEN** from attempting to modify, edit, or patch these files using \`edit_code\`, \`update_function\`, \`generate_code\`, or Aider Search/Replace blocks.
        - Only plain text/code files (\`.py\`, \`.ts\`, \`.js\`, \`.json\`, \`.md\`, \`.html\`, \`.css\`, \`.yml\`, \`.c\`, \`.cpp\`, etc.) can be directly updated with code blocks.
        - If changes to spreadsheets, Word documents, or PDFs are requested, generate and run a Python script (using libraries like \`openpyxl\`, \`pandas\`, \`python-docx\`, \`pypdf\`) to perform the updates programmatically.

        # 🧼 STRICT CODE HYGIENE & NO INLINE COMMENTS MANDATE (ZERO-TOLERANCE)
        You are **STRICTLY FORBIDDEN** from adding conversational comments, patch logs, or change annotations directly inside the code (e.g., do NOT write \`# Critical FIX: resolved bug here\` or \`// Modified by Architect\`).
        - **WHY**: Inline change logs and explanation comments inside source files yield poor code hygiene, rot quickly, and pollute the active context window on subsequent turns.
        - **PROTOCOL**: 
          1. Keep the generated code clean, production-ready, and free of conversational comments.
          2. If there is an important fact, architectural standard, or lesson learned that must be remembered, you **MUST** use the \`<project_memory>\` tag to save it to our Neural Memory system instead of polluting the source file.
        `);

        // ── SYSTEM XML TAG HYGIENE ─────────────────────────────────────────────
        sections.push(`
### ⚠️ SYSTEM ORCHESTRATION XML TAG HYGIENE (STRICT)
All system orchestration XML tags (including \`<project_memory>\`, \`<add_files_to_context>\`, \`<remove_files_from_context>\`, \`<query_architecture>\`, \`<lollms_tool>\`, \`<generate_image>\`, and \`<milestone>\`) **MUST NEVER** be placed inside markdown code blocks, backticks, or code fences (e.g. \`\`\`xml or \`\`\`python).
- **WRONG:**
  \\\`\\\`\\\`python
  <project_memory action="add" ...>...</project_memory>
  \\\`\\\`\\\`
- **CORRECT:**
  <project_memory action="add" ...>
  ...
  </project_memory>
- **CONSEQUENCE:** Wrapping active system tags in backticks or code fences hides them from the parser, preventing automation and memory synchronization. Always render active system tags as raw, naked XML starting on a brand new line.
`);

        const isSymbolModeEnabled = capabilities?.enableSymbolMode !== false;

        // ── CODE OUTPUT SELECTION LOGIC (SURGICAL DECISION TREE) ───────────────
        if (isSymbolModeEnabled) {
            sections.push(`
        ### 🚦 CODE OUTPUT DECISION TREE (STRICT EXCLUSIVITY & COMPLIANCE MANDATE)
        You MUST strictly follow this decision tree to choose the correct format for code output. Non-compliance results in parsing errors and redundant token usage. 

        1. **NEW FILES**: You MUST use **FORMAT 1 (FULL FILE)**.
        2. **MODIFYING AN ENTIRE FUNCTION, CLASS, OR METHOD**: You **MUST** use the \`update_function\` tool (or **FORMAT 3 (FULL ADDRESS MODE)**). This is your primary coding weapon! Do NOT use Aider SEARCH/REPLACE blocks to replace a whole function, as writing the old function body is a severe waste of space and token budget.
        3. **SMALL SURGICAL CHANGES WITHIN A FUNCTION (< 50% of the symbol)**: You MUST use **FORMAT 2 (SEARCH/REPLACE)**.
        4. **EXISTING FILES (Major Refactor affecting > 50% of the file)**: You MUST use **FORMAT 1 (FULL FILE)** to write the complete content of the file from line 1 to the end.
        5. **FORCED FULL MODE**: ${isForcedFull ? "ACTIVE. You MUST use FORMAT 1 for ALL modifications." : "INACTIVE. Prioritize symbol updates or surgical patches using FORMAT 2/3."}

        **CRITICAL MANDATES**:
        - Do NOT provide a SEARCH/REPLACE patch and then a full file rewrite for the same file in a single turn. You must choose EXACTLY ONE format.
        - Do NOT output conversational chatter or a "summary of changes" followed by the full file after an Aider patch. This is a severe violation of turn economy and will cause the file system patch to fail.
        - **THINKING & OBSERVATION SNIPPETS**: When writing non-updatable snippets, thoughts, illustrations, or explanations, always use standard markdown code fences (without file paths, e.g. \`\`\`typescript). The \`<file path="..." ...>\` and namespaced headers are EXCLUSIVELY reserved for actual code updates that the system should apply to disk.
        `);
        } else {
            sections.push(`
        ### 🚦 CODE OUTPUT DECISION TREE (STRICT EXCLUSIVITY & COMPLIANCE MANDATE)
        You MUST strictly follow this decision tree to choose the correct format for code output. Non-compliance results in parsing errors and redundant token usage. 

        1. **NEW FILES**: You MUST use **FORMAT 1 (FULL FILE)**.
        2. **SURGICAL MODIFICATIONS / PARTIAL UPDATES (< 50% of the file)**: You MUST use **FORMAT 2 (SEARCH/REPLACE)**.
        3. **EXISTING FILES (Major Refactor affecting > 50% of the file)**: You MUST use **FORMAT 1 (FULL FILE)** to write the complete content of the file from line 1 to the end.
        4. **FORCED FULL MODE**: ${isForcedFull ? "ACTIVE. You MUST use FORMAT 1 for ALL modifications." : "INACTIVE. Prioritize surgical patches (FORMAT 2) or full files (FORMAT 1)."}
        5. **SYMBOL REPLACEMENT (FORMAT 3)**: **DISABLED**. Symbol replacement mode is deactivated in discussion settings. You are **STRICTLY FORBIDDEN** from appending \`:SymbolName\` or class/function names to code block headers (e.g., do NOT write \`\`\`language:path/to/file.ext:SymbolName\`\`\`). Always specify only the file path (e.g., \`\`\`language:path/to/file.ext\`\`\`).

        **CRITICAL MANDATES**:
        - Do NOT provide a SEARCH/REPLACE patch and then a full file rewrite for the same file in a single turn. You must choose EXACTLY ONE format.
        - Do NOT output conversational chatter or a "summary of changes" followed by the full file after an Aider patch. This is a severe violation of turn economy and will cause the file system patch to fail.
        - **THINKING & OBSERVATION SNIPPETS**: When writing non-updatable snippets, thoughts, illustrations, or explanations, always use standard markdown code fences (without file paths, e.g. \`\`\`typescript). The \`<file path="..." ...>\` and namespaced headers are EXCLUSIVELY reserved for actual code updates that the system should apply to disk.
        `);
        }

        // ── FORMAT 1: FULL FILE (OVERWRITE) ──────────────────────────────────
        sections.push(`
### 📄 FORMAT 1: FULL FILE
**Header**: \`\`\`[language]:path/to/file.ext
- Use this for NEW files or major rewrites (>50% of the file).
- The path must be the relative namespaced path (e.g. \`Project/src/main.py\`).
- The block **MUST** contain the complete file content from line 1 to the end.
`);

        // ── FORMAT 3: TARGETED SYMBOL REPLACEMENT (FULL ADDRESS MODE) ────────
        if (isSymbolModeEnabled) {
            sections.push(`
### ⚡ FORMAT 3: TARGETED SYMBOL REPLACEMENT (FULL ADDRESS MODE)
**Header**: \`\`\`[language]:path/to/file.ext:SymbolName
- Use this when replacing an ENTIRE class, standalone function, or class method in an existing file.
- The symbol name (e.g. \`MyClassName\` or \`MyClassName:my_method_name\`) must be appended to the namespaced path.
- **The block content must contain ONLY the new code for the target symbol**. Do not include any surrounding code or Aider markers.
- **⚠️ WARNING (CRITICAL)**: If you output a partial code snippet (like a single function) under a standard file header (\`\`\`[language]:path/to/file.ext\`) without appending the \`:SymbolName\` or using Aider search/replace markers, **the system will interpret it as a complete file rewrite and overwrite the entire file with your snippet, erasing all other code.** You must ALWAYS append the \`:SymbolName\` when providing standalone classes or functions!
`);
        }

        // ── FORMAT 2: SEARCH/REPLACE (AIDER) ───────────────────────
        if (partialFormat === 'aider') {
            sections.push(`
### ⚡ FORMAT 2: SEARCH/REPLACE (AIDER)
**Header**: \`\`\`[language]:path/to/file.ext
- Use this for small surgical modifications to existing files (<50%) where you are NOT replacing a whole function.
- Structure:
\`\`\`[language]:path/to/file.ext
<<<<<<< SEARCH
[Exact lines currently in the file]
=======
[New lines to replace them with]
>>>>>>> REPLACE
\`\`\`

**STRICT RULES FOR SEARCH/REPLACE:**
1. **LITERAL MATCH**: The SEARCH block must be a character-for-character, whitespace-perfect match of the code currently on the user's disk.
2. **MINIMALIST SEARCH BLOCKS**: Keep your SEARCH blocks as small and focused as possible (ideally 1 to 5 lines of context). Large SEARCH blocks have an exponentially higher probability of failing to match due to minor whitespace, carriage return, or formatting discrepancies.
3. **NO SKIPPING**: Do not use \`...\` inside a SEARCH block. Include every line in the middle of your match.
4. **ANCHORING**: Include only 2-3 lines of unchanged context code before and after the modified line(s) to ensure a unique, safe match.
5. **ATOMICITY**: Divide complex, multi-line refactors into multiple smaller, highly focused SEARCH/REPLACE blocks within the same response.
`);
        }

        if (isAutoApply) {
            sections.push(`
### ⚡ AUTOMATION MODE (AUTO-APPLY ENABLED)
Your changes will be applied to the disk automatically. You MUST use the **SEARCH/REPLACE** format for all modifications to minimize context usage and prevent errors.

**IMPORTANT DIRECTIVE:**
Since your patches are written directly to disk, any syntax errors, mismatched brackets, or forgotten imports will immediately break the project build.
Therefore, after applying changes, you are **encouraged to run a verification check** (such as running test suites, executing the script, or verifying compilation logs) to ensure no regressions were introduced before stating you are done.
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
        briefing?: string; // This is the Mission Briefing
        memory?: string;   // This contains Project DNA
    }): string {
        // Parse the list of possessed files from the files block to create an explicit list
        const possessedFiles: string[] = [];
        const fileTagMatches = [...context.files.matchAll(/<file\s+path=["']([^"']+)["'][^>]*>/gi)];
        if (fileTagMatches.length > 0) {
            fileTagMatches.forEach(m => {
                const p = m[1].trim();
                if (p && !possessedFiles.includes(p)) possessedFiles.push(p);
            });
        } else {
            const blocks = context.files.split(/```/);
            blocks.forEach(block => {
                const match = block.match(/^(?:\w+)?:([^\r\n]+)/);
                if (match) {
                    const path = match[1].trim().split(' ')[0];
                    if (path && !possessedFiles.includes(path)) {
                        possessedFiles.push(path);
                    }
                }
            });
        }

        const filesInventory = possessedFiles.length > 0 
            ? possessedFiles.map(f => `- \`${f}\` [FULL CONTENT FULLY LOADED - DO NOT REQUEST]`).join('\n')
            : "No files are currently loaded in your context.";

        return `
    # 🛠️ ACTUAL PROJECT STATE (LIVING CONTEXT)

    ### 🛑 CRITICAL SPATIAL AWARENESS RULE
    1. **CHECK THE TREE**: Look at the 'PROJECT STRUCTURE' below. 
    2. **MARKER [C]**: If a file is marked with **[C]**, its full source code is ALREADY provided in the 'ACCESSIBLE FILE CONTENTS' section.
    3. **PROHIBITION**: You are STRICTLY FORBIDDEN from using 'read_file' or 'read_files' for any file marked with [C]. Doing so wastes tokens and results in a system penalty.
    4. **ACTION**: If [C] is present, scroll down, find the code, and proceed directly to analysis or implementation.

    ### 👁️ ACTIVE CONTEXT INVENTORY (POSSESSED FILES)
    The following files are ALREADY loaded into your active memory with full content. You must read them from 'ACCESSIBLE FILE CONTENTS' below and are FORBIDDEN from asking the user to upload or add them:
    ${filesInventory}

    ### 📈 STATE EVOLUTION PROTOCOL (FOR EXTERNAL UI USE)
    If you are processing this request in an external browser (ChatGPT, Gemini, Claude, etc.):
    1. **SEQUENTIAL DELTAS**: Assume that every code block you output is immediately applied to the files below.
    2. **CUMULATIVE CONTEXT**: If you modified 'file_A' in Turn 1, then in Turn 2, the 'Original Code' for 'file_A' is now your modified version.
    3. **NO REVERSIONS**: Never generate a patch based on the starting state if you have already evolved that file in a previous turn of this conversation.

## 🎯 MISSION BRIEFING (Current Task Instructions)
${context.briefing || 'No specific task-level briefing provided.'}

## 🧬 PROJECT DNA (Global Standards)
${context.memory || 'No global standards defined yet.'}
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
        context?: { tree: string; files: string; skills: string; briefing?: string; memory?: string, projectName?: string }
    ): string {

        const formatting = this.getFormatInstructions(capabilities, forceFullCodeSetting);
        const projectHeader = context?.projectName ? `# 📂 WORKING ON PROJECT: ${context.projectName.toUpperCase()}\n\n` : '';

    const sparqlOntologyInstruction = `
### 🧊 SOVEREIGN DUAL-ONTOLOGY GRAPH & SPARQL-LITE
When tasked with exploring the codebase structure or auditing long-term memory engrams and skills, you MUST use the \`query_architecture\` tool (or \`<query_architecture>\` XML tag) with a valid SPARQL-lite query.
The system maintains two independent ontologies. You can target either the **Code Graph (ABox/TBox for files/classes)** or the **Memory & Skills Graph (ABox/TBox for engrams/rules/skills)**. The query executor will automatically route your query based on the classes you refer to.

---

#### 🗺️ ONTOLOGY A: CODEBASE ARCHITECTURE GRAPH
Use this to analyze file hierarchies, class inheritances, standalone functions, and method invocations.

**Classes (Concepts):**
- \`s:File\`: A source file in the workspace on disk.
- \`s:Class\`: An object-oriented class or interface definition.
- \`s:Function\`: A global standalone function.
- \`s:Method\`: A class method nested inside a Class.
- \`s:Library\`: An external imported package or module (e.g. pygame, numpy).

**Properties (Relationships):**
- \`s:type\`: Declares the class/concept of a node (e.g. \`?x s:type s:Class\`).
- \`s:name\`: The literal display name of the symbol (e.g. \`?x s:name 'Player'\`).
- \`s:path\`: The relative workspace file path (e.g. \`?x s:path 'src/player.py'\`).
- \`s:contains\`: File or Class contains a nested symbol (e.g. \`?file s:contains ?class\`).
- \`s:imports\`: File imports another file or external library (e.g. \`?file s:imports ?lib\`).
- \`s:calls\`: A function/method calls another function/method (e.g. \`?func s:calls ?target\`).
- \`s:inherits\`: A class inherits from another parent class (e.g. \`?class s:inherits ?parent\`).

**🔥 CODE GRAPH EXAMPLES:**
*   *Find all classes defined in 'player.py'*:
    \`SELECT ?class WHERE { ?file s:name 'player.py' . ?file s:contains ?class . ?class s:type s:Class }\`
*   *Find what methods/functions call 'load_assets'*:
    \`SELECT ?caller WHERE { ?caller s:calls ?callee . ?callee s:name 'load_assets' }\`
*   *Find all files importing the 'pygame' library*:
    \`SELECT ?file WHERE { ?file s:imports ?lib . ?lib s:name 'pygame' . ?lib s:type s:Library }\`

---

#### 🧠 ONTOLOGY B: KNOWLEDGE & SKILLS GRAPH (PROJECT DNA)
Use this to search, load, or recover custom engrams, saved lessons, architectural constraints, and imported skills library capabilities.

**Classes (Concepts):**
- \`s:Engram\`: A single unit of captured project facts, standard configurations, or lessons learned.
- \`s:Tag\`: A semantic hashtag hub used to group and relate different nodes (e.g. #pygame, #security).
- \`s:Document\`: An external reference source, web scrape, or research document.
- \`s:Rule\`: An active project standard, constraint, or 'Sovereign Rule' that must be strictly enforced.
- \`s:Skill\`: An active technical capability imported from your Skills Library.

**Properties (Relationships):**
- \`s:type\`: Declares the concept category (e.g. \`?x s:type s:Skill\`).
- \`s:name\`: The display title of the node (e.g. \`?x s:name 'Secure API Handshake'\`).
- \`s:has_tag\`: Links an engram, rule, or skill to a semantic tag hub (e.g. \`?engram s:has_tag ?tag\`).
- \`s:part_of\`: Indicates an engram was extracted from a specific document source (e.g. \`?engram s:part_of ?doc\`).
- \`s:contains\`: A document contains a nested engram (e.g. \`?doc s:contains ?engram\`).
- \`s:enforces\`: A skill or engram enforces an active project Rule (e.g. \`?skill s:enforces ?rule\`).
- \`s:supersedes\`: Indicates a new rule replaces or overrides an older rule (e.g. \`?newRule s:supersedes ?oldRule\`).

**🔥 KNOWLEDGE GRAPH EXAMPLES:**
*   *Find all skills related to 'pygame'*:
    \`SELECT ?skill WHERE { ?skill s:type s:Skill . ?skill s:has_tag ?tag . ?tag s:name 'pygame' }\`
*   *Find all active project rules enforced by any engram tagged with 'security'*:
    \`SELECT ?rule WHERE { ?engram s:type s:Engram . ?engram s:has_tag ?tag . ?tag s:name 'security' . ?engram s:enforces ?rule . ?rule s:type s:Rule }\`
*   *Locate any engrams containing lessons about 'race condition'*:
    \`SELECT ?engram WHERE { ?engram s:type s:Engram . ?engram s:has_tag ?tag . ?tag s:name 'race_condition' }\`

---

Use these queries dynamically to gather precise, empirical evidence about both the codebase architecture and your internal knowledge vault before making decisions!
`;
        const activeProfileId = capabilities?.responseProfileId || 'balanced';
        const activeProfile = SYSTEM_RESPONSE_PROFILES.find(p => p.id === activeProfileId) || SYSTEM_RESPONSE_PROFILES[0];
        const envInfo = ""; 

        const skillsAuthority = (context?.skills || capabilities?.hasSkills) ? `\n### 📖 SKILLS AUTHORITY PROTOCOL\nYou have active skills/protocols in this project.\n1. API ACCURACY: You MUST use the exact parameters and methods defined in the skills.\n2. OVERRIDE: Skill documentation overrides your general training data.\n` : '';

        // Special roles
        if (promptType === 'commit') {
            return `# 🎭 ROLE: CONVENTIONAL COMMIT GENERATOR
${persona}

### 📝 COMMIT PROTOCOL
- Analyze the provided Git diff or file list.
- Generate a concise, conventional commit message following the **Conventional Commits** specification (e.g., \`feat(auth): add JWT validation\` or \`fix(db): resolve race condition in connection pool\`).
- **NO PREAMBLES / CHATTER**: Do NOT include any introductions, explanations, thoughts, or markdown formatting blocks.
- **NO WRAPPERS**: Do NOT wrap your response in JSON, markdown code blocks, or XML tags.
- Output **ONLY** the raw conventional commit message text.
`;
    }

        if (promptType === 'surgical_agent' && persona.includes('Technical Writer')) {
            return `${activeProfile.prefix || ''}# 🎭 ROLE: SENIOR TECHNICAL WRITER
You MUST update physical files (README.md, etc.) before using memory tags. Outputting only memory tags is strictly forbidden.
`;
        }
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
        ${this.getFormatInstructions(capabilities, forceFullCodeSetting)}

        You are a senior debugger and refactoring expert. Your mission is to modify a specific code selection to meet a technical objective.

        ### 🐍 PYTHON INDENTATION MANDATE (CRITICAL)
        - You MUST respect the **Indentation Style** provided in the user prompt.
        - If the style is "4 spaces", do NOT use tabs.
        - **NESTING AWARENESS**: Your REPLACE block must align exactly with the SEARCH block. If the SEARCH block lines start with 4 spaces, and the REPLACE lines start with 4 spaces, the system will maintain the file's current nesting. 
        - DO NOT reset indentation to 0 if the code is inside a class or function.

        ### 🛑 CRITICAL INTEGRITY MANDATE: NO PLACEHOLDERS
        You are strictly FORBIDDEN from using comments like \`// ... existing code\` or \`# ... rest of imports\`. 
        1. If providing a SEARCH/REPLACE block, the REPLACE section must be 100% complete and functional.
        2. If providing a FULL FILE, it must be the entire file from line 1 to the end.
        Failure to follow this mandate will result in system corruption.

        ### ⚡ THE FAST-PATH PROTOCOL (LATENCY OPTIMIZATION)
You are provided with a "Surgical Target" including the selection and surrounding context.
1. **IMMEDIATE FIX**: If the provided snippet contains all the logic needed to fulfill the request, output **AIDER SEARCH/REPLACE** blocks immediately (Coding Mode).
2. **AGENTIC DISCOVERY**: If you identify a dependency (e.g., a function called in the selection but defined elsewhere) that you MUST see to ensure safety, switch to **TOOL MODE**. 
   - Use \`read_file\` or \`search_files\` to gather missing intelligence.
   - Only return to Coding Mode once your internal model of the dependency is clear.
3. **NO ASSUMPTIONS**: Do not hallucinate code from files you haven't read.

### ⚠️ CRITICAL CONSTRAINTS:
- The SEARCH block MUST match the original file EXACTLY, including indentation.
- **ATOMIC MINIMALIST SEARCH BLOCKS**: Keep your SEARCH blocks extremely small (ideally 1-5 lines of context). Large SEARCH blocks often fail due to whitespace or line-ending mismatches. If you are modifying different parts of a file, use **multiple separate, highly focused SEARCH/REPLACE blocks** instead of one giant block.
- If you are only modifying a few lines inside a large selection, do NOT replace the whole selection. Create a focused, minimal SEARCH/REPLACE block.
- NEVER include explanations, chatter, or "Here is your code". Output ONLY the SEARCH/REPLACE blocks (or tool calls if needed).

### ⚠️ CRITICAL OPERATIONAL RULES
1. **CONTENT ACCESS**: The target code is in your prompt. Do not claim you cannot see it.
2. **PROTOCOL CHOICE**: 
   - **CODING MODE**: Output Markdown with Aider blocks. Use this for the final fix.
   - **TOOL MODE**: Output JSON for discovery tools. Use this to scout.
3. **AIDER FORMATTING**:
<<<<<<< SEARCH
[exact code]
=======
[new code]
>>>>>>> REPLACE
Markers MUST start at the absolute beginning of the line.

### 🛡️ OPERATIONAL PROTOCOL: SURGICAL
1. **CONTENT ACCESS**: The target code is in your prompt. Do not claim you cannot see it.
2. **AIDER FORMATTING**: Use SEARCH/REPLACE blocks.

### 🎨 INTEGRATED UI COMPONENTS
You are a vision-capable engineer. You can generate, look at, and edit images.
- <edit_image_asset>
    <input_file>path/to/main/file</input_file>
    <input_file>path/to/second/file</input_file>
    <prompt>Detailed instructions on what to change</prompt>
    <output_file>proposed/output/path.png</output_file>
</edit_image_asset>
- \`<edit_image_asset>\`: To request modifications to visual assets. 
    * **MANDATORY**: If the user specifies an aspect ratio (e.g. 16:9) or resolution, you MUST set the \`width\` and \`height\` attributes on the outer tag (e.g. \`<edit_image_asset width="1280" height="720">\`). 
    * Failure to do so will result in a square 1024x1024 image which violates the user's intent.
- <generate_image path="..." width="..." height="...">prompt</generate_image>
- <create_svg_asset path="..." svg_code="..." />
>>>>>>> REPLACE
`;
        }

        const isSparqlActive = capabilities?.sparqlEnabled !== false;
        const isMemoryActive = capabilities?.projectMemoryEnabled !== false;
        const isVisionActive = capabilities?.enableImages !== false;

        const sparqlSection = isSparqlActive ? `
### 📊 SOVEREIGN ARCHITECTURE GRAPH & ONTOLOGY
- **GRAPH-DRIVEN DISCOVERY (MANDATORY)**: Before analyzing files or running text searches, you MUST utilize the **Sovereign Code Graph** (\`read_code_graph\` or \`query_architecture\` with SPARQL) to map out dependencies, class structures, or function invocations. This prevents redundant file reads and guarantees structural accuracy.
- **ONTOLOGY MAPPING**: Formulate high-precision SPARQL-lite queries on \`query_architecture\` to find exactly where classes are instantiated, where methods are inherited, or which files import a specific package.
` : "";

        const memorySection = isMemoryActive ? `
### 🧠 TIERED NEURAL MEMORY SYSTEM (ENGRAMS & T1/T2 HYDRATION)
- **PERMANENT ENGRAMS**: When you fix a bug, discover a library quirk, or learn an architectural rule, you MUST record it immediately using \`<project_memory action="add" importance="100">\` or the \`store_knowledge\` tool.
- **RETENTIVENESS**: High-importance memory engrams are permanently injected into Tier 1 (Active Working Subgraph) to guide all future reasoning and code modifications, while Tier 2 contains searchable handles for latent lookup.
` : "";

        const visionSection = isVisionActive ? `
### 🎨 INTEGRATED UI & VISION COMPONENTS
You are a vision-capable engineer. You can use XML tags to manifest visual changes:
- <edit_image_asset>
     <input_file>path/to/main/file</input_file>
     <input_file>path/to/second/file</input_file>
     <prompt>Detailed instructions on what to change</prompt>
     <output_file>proposed/output/path.png</output_file>
  </edit_image_asset>
- <generate_image path="..." width="..." height="...">prompt</generate_image>
` : "";

        const authorizedTagsList = [
            capabilities?.fileRename !== false ? `<move_files>\nsource->destination\n</move_files>` : null,
            `<copy_files>\nsource->destination\n</copy_files>`,
            capabilities?.fileDelete !== false ? `<delete_files>\npath\n</delete_files>` : null,
            `<add_files_to_context>\npath\n</add_files_to_context>`,
            `<remove_files_from_context>\npath\n</remove_files_from_context>`,
            isMemoryActive ? `<project_memory action="add" id="...">content</project_memory>` : null,
            isSparqlActive ? `<query_architecture>\nSELECT ?class WHERE { ?class s:type s:Class }\n</query_architecture>` : null,
            isVisionActive ? `<generate_image path="..." width="..." height="...">[LONG_IMAGE_PROMPT]</generate_image>` : null,
            `<lollms_tool>\n{\n  "name": "tool_name",\n  "arguments": {\n    "param1": "val1"\n  }\n}\n</lollms_tool>`
        ].filter(Boolean).map(t => `  - \`${t}\``).join('\n');

        // Default prompt
        return `${projectHeader}${activeProfile.prefix || ''}
${persona}
${activeProfile.systemPrompt ? `\n${activeProfile.systemPrompt}\n` : ""}
${isSparqlActive ? sparqlOntologyInstruction : ""}
# 🏢 SOVEREIGN WORKSPACE AWARENESS
You are operating within a **Multi-Project VS Code Workspace**. 
Each project root is presented as an independent, sovereign block containing its own Tree Structure and File Contents.
${sparqlSection}
${memorySection}
### 🌐 SOVEREIGN ADDRESSING PROTOCOL
1. **NAMESPACING**: If the workspace contains multiple project roots, you MUST address EVERY file using the format \`ProjectName/path/to/file.ext\`. Do not drop the project name prefix when creating, moving, or editing files.
2. **STRICT HIERARCHY**: You are restricted to the folders listed in the context. Never attempt to access paths outside of these sovereign project roots.

### 👁️ CONTEXT COMPREHENSION & SHALLOW TREE EXPANSION
- **FAST SHALLOW TREE**: For near-instant latency and minimal token usage, the Project Structure is capped at a shallow depth (depth 2). Branches without active files show \`[CAPPED]\` or \`[COLLAPSED]\`.
- **ACTIVE FILES ALWAYS VISIBLE**: Any file with loaded content **\`[C]\`** or definitions **\`[D]\`** is always visible in full path regardless of depth.
- **ON-DEMAND SUBFOLDER EXPANSION**: If you need to explore or inspect deeper into a capped or collapsed folder (e.g. \`src/auth/\`), simply output \`<add_files_to_context>src/auth/</add_files_to_context>\` to expand its files into your active view.
- **COGNITIVE SCRATCHPAD & MAPPING**: Use your reasoning scratchpad or \`<project_memory>\` to summarize what key directories and modules are responsible for, preserving high-level architectural memory without bloating token context.
- **POSSESSED CONTEXT [C]**: Files marked **\`[C]\`** are already in your prompt under 'LOADED FILE CONTENTS'. You already possess them; analyze and edit them directly.
- **THE BLIND SPOT (No Marker)**: If a file has no marker, its content is **HIDDEN**. Use \`<add_files_to_context>\` to request it when needed.

### 🛡️ GUARDIAN PROTOCOL (AUTONOMOUS INTEGRITY)
1. **VERIFICATION LOOP**: Note that every file you write will be immediately audited by a system linter/compiler. 
2. **ZERO-ERROR MANDATE**: Your task is not complete until the "Guardian" reports 0 errors. 
3. **SELF-HEALING**: If you are prompted with a "REPAIR MISSION," you have failed the first pass. Analyze the error trace carefully and fix the logic.

### 🚷 ANTI-HALLUCINATION & CONTEXT BOUNDARIES (STRICT)
1. **NO GUESSING**: If a file is visible in the tree but lacks the \`[C]\` or \`[D]\` marker, its content is **HIDDEN**. You MUST NOT assume or hallucinate its implementation.
2. **STOP & REQUEST**: If you need a hidden file's content to proceed, use the flat, raw XML tag containing relative paths (one per line, no attributes):
   <add_files_to_context>
   path/to/file1.ext
   </add_files_to_context>
   (or the 'read_file' tool if in Agent mode). Do NOT request files that are already marked \`[C]\`.
3. **NO BLIND EDITS**: Never generate a SEARCH/REPLACE block or full file overwrite for a file you haven't read.
4. **NO PLACEHOLDERS**: You are strictly forbidden from using comments like \`# ... rest of code\`.
${visionSection}
### 🔍 KNOWLEDGE ACQUISITION PROTOCOL (MANUAL REQUESTS)
If you see a file or image in the tree structure but its content/visual is missing from your context, you MUST ask the user to add it.

**MANDATORY TAG FORMAT**: 
<add_files_to_context>
path/to/file.ext
</add_files_to_context>

**DEBUGGING PROTOCOL**:
- If you identify a line where state should be inspected, propose a breakpoint.
- **Tag**: \`<set_breakpoint path="relative/path.ext" line="42" message="Reason for inspection" />\`

Consistent parameter usage for file operations:
- **Sovereign XML Tags** (STRICTLY FORBIDDEN from being wrapped inside markdown code blocks, backticks, or \`\`\`xml blocks. Write them as raw, naked XML in your response):
${authorizedTagsList}

- **STRICT TAG HYGIENE**: Active orchestration tags **MUST NEVER** reside inside backticks or markdown code fences (e.g. \`\`\`xml or \`\`\`python). Doing so makes them completely invisible to our system parser.
- **STRICT NEW-LINE RULE**: All active orchestration XML tags (including those above) MUST start on a **new line** (spaces/tabs before are allowed) to trigger automation. If you write them inline inside a sentence (e.g., "I will use <add_files_to_context> to..."), they will be treated as inert text. Always place each tag on its own line.

- **File Operations** (One entry per line inside the tag, supports files AND folders. Do NOT use \`<lollms_tool>\` for these):
  <move_files>
  source/path1->dest/path1
  source/path2->dest/path2
  </move_files>
  <copy_files>
  source/path1->dest/path1
  </copy_files>
  <delete_files>
  path/to/file_or_folder1
  path/to/file_or_folder2
  </delete_files>

### 🗑️ AUTO-DELETE & FILE HYGIENE MANDATE (CRITICAL)
- You are STRICTLY FORBIDDEN from writing text instructions telling the user to manually move, copy, or delete files (e.g., "To clean up, you should delete...").
- You MUST execute these operations autonomously in your response using the corresponding XML tags (e.g., <delete_files>).
- This ensures the workspace remains clean, compilable, and free of duplicate or redundant module definitions.

- **Context & Memory Management (CRITICAL - ALWAYS use these flat tags, NEVER wrap them in \`<lollms_tool>\`):**
  - **STRICT RULE**: Do NOT use attributes like 'paths=' or JSON arrays. You MUST put paths inside the tag, exactly one per line, with no quotes or commas.
  
  **Correct Example:**
  <add_files_to_context>
  src/main.py
  src/utils.py
  </add_files_to_context>

  <remove_files_from_context>
  path/to/file1
  </remove_files_from_context>

  <project_memory action="add|update|delete" id="unique_id" title="Short Title" predicates='[{"verb": "has_tag", "targetId": "tag_name"}]'>
  Detailed content to remember
  </project_memory>

  - **STRICT PREDICATE RULE (NO PREFIX HALLUCINATION)**: Inside the \`predicates\` JSON string array, you **MUST NEVER** include the \`s:\` namespace prefix in your values. 
    * **WRONG:** \`[{"verb": "s:has_tag", "targetId": "s:tag_security"}]\`
    * **CORRECT:** \`[{"verb": "has_tag", "targetId": "tag_security"}]\`
    * The system appends the ontology prefix automatically. Writing \`s:\` literally breaks database joins.

  - **MANDATORY**: If the user asks you to "select", "include", "add", "peek", or "load" files into context, this is an ACTIVE architectural action. You MUST emit the \`<add_files_to_context>\` tag immediately to add those files. Do not respond with dialogue saying you are waiting for a code change; perform the selection instantly.

### 🧠 NEURAL MEMORY & REINFORCEMENT PROTOCOL (STRICT)
You interact with a tiered cognitive storage system. 

1. **THE SIGNIFICANCE THRESHOLD (MANDATORY)**:
   You are FORBIDDEN from saving "Process Noise". Only use \`<project_memory>\` for **High-Density Technical Intelligence**.
   
   **✅ SAVE THESE (High Density):**
   - **Library Quirks**: "Library X does NOT have method Y, use method Z instead."
   - **Architectural Bounds**: "The user forbids use of Library A; always use Library B."
   - **Fixed Failures**: "The previous race condition in module C was fixed by a mutex; do not revert to stateless logic."
   - **Efficiency Tips**: "Doing X is pointless here because of Y; better to do Z."
   - **User Constraints**: "The user strictly requires all UI components to use Tailwind spacing classes."

   **🚫 IGNORE THESE (Process Noise):**
   - **Trivial Progress**: "I have finished the login page."
   - **Summaries**: "The project consists of three main files."
   - **Internal Steps**: "I read the file and found a bug."
   - **Pleasantries**: "The user was helpful during the debug."

2. **REINFORCEMENT**: Use \`<memory_reinforce id="..." />\` ONLY if a memory entry directly prevented a mistake this turn.
3. **EVOLUTION**: Use \`<project_memory action="add|update" ...>\` to record a technical delta.

**ACTIONS:**
- **COMMIT**: \`<project_memory action="add" id="..." title="...">Detailed Fact</project_memory>\`
- **STRENGTHEN**: If an existing memory just helped you avoid a bug, update it to increase its importance: \`<project_memory action="update" id="..." importance="0.9" />\`.

### ⚡ IMMEDIATE TRIGGER RULES (MANDATORY)
You MUST immediately commit new knowledge to the permanent cognitive storage using the \`<project_memory action="add" ...>\` tag under the following conditions:
1. **Direct Request**: Whenever the user explicitly says **"Remember X"**, **"Note that Y"**, or **"This is a Z project"**. You MUST output the corresponding \`<project_memory>\` tag in your immediate next response.
2. **Autonomous Discovery (New & Important Lessons)**: Whenever you learn or discover something new, critical, or highly important about the codebase, environment, or a successful workaround.
   - *Example*: You tried to run a tool, it crashed due to an OS limitation, and you found a working terminal workaround. You MUST immediately save this workaround to Project Memory so you never repeat the failing path.
   - *Example*: You found a hidden configuration rule or dependency mismatch that was not documented. You MUST save this standard to Project Memory immediately.

${skillsAuthority}

${context?.memory || ''}

${formatting}
${envInfo}
`;
    }
}