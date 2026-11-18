export class LibrarianPromptBuilder {

    /**
     * Builds the prompt for Phase 0: Fast Inspection of Current Context.
     * Evaluates whether the current active file selection in context [C] is already
     * sufficient to answer the prompt or implement the requested task.
     */
    public static getFastInspectionPrompt(
        userPrompt: string,
        activeFilesCatalog: string,
        projectTree: string,
        recalledMemories: string,
        previousFindings: string
    ): string {
        return `You are the Lead Sovereign Librarian & Master Architect.

### PHASE 0: FAST INSPECTION OF CURRENT CONTEXT
Your mission is to perform a fast, preliminary evaluation of the user's objective against the current active files selection.

### OBJECTIVE:
"${userPrompt}"

${recalledMemories ? `### 🧠 RECALLED PROJECT MEMORIES & STANDARDS:\n${recalledMemories}\n\n` : ''}${previousFindings ? `### 🏛️ PREVIOUS ARCHITECTURE FINDINGS (.lollms/structure.md):\n${previousFindings}\n\n` : ''}### 📂 ACTIVE FILES IN CONTEXT:
${activeFilesCatalog || '(No files currently loaded)'}

### 🌳 PROJECT STRUCTURE TREE:
${projectTree ? projectTree.substring(0, 3000) : '(No tree available)'}

### INSTRUCTIONS:
Determine whether the current active file selection is **sufficient** to perform the requested task.
- If all target code files, stylesheets, components, or docs required to fulfill the request are ALREADY loaded with full content under active files, respond with \`sufficient="True"\`.
- If the required files are missing, unknown, muted, or if codebase scouting (grep/AST/SPARQL) is required to locate the problem site, respond with \`sufficient="False"\`.

MANDATORY OUTPUT FORMAT:
<librarian_decision sufficient="True" or "False">
Explain clearly why the current files selection is sufficient to perform the task or why it is not sufficient.
</librarian_decision>`;
    }

    /**
     * Builds the system prompt for the Lead Sovereign Librarian for Phase 1 Scouting,
     * Phase 2 Understanding, and Phase 3 Planning.
     */
    public static getMasterLibrarianSystemPrompt(
        maxTokens: number,
        objectiveThreshold: number,
        objectiveThresholdPercent: number,
        maxRounds: number,
        sparqlEnabled: boolean = true,
        ignoreContextSize: boolean = false
    ): string {
        const sparqlSection = sparqlEnabled ? `
- **SPARQL Architecture Query**:
  Query the Code Architecture Graph (.lollms/knowledge.ttl) directly.
  Tag: \`<sparql query="SELECT ?class WHERE { ?class a s:ClassDefinition }" />\`
` : ``;

        const budgetSection = ignoreContextSize ? `
⚠️ **UNLIMITED CONTEXT MODE ACTIVE**:
- Context token capacity limits are ignored. Plan single-phase execution if appropriate.
` : `
Capacity limit: ${maxTokens.toLocaleString()} tokens.
Target budget: ~${objectiveThreshold.toLocaleString()} tokens (${objectiveThresholdPercent}%).
`;

        return `You are the **Lead Sovereign Librarian and Master Architect**.
Your mission is to be the master orchestrator of this project. You examine the codebase, scout for information, understand the workings, formulate a plan, and select the precise files for the Coder.
${budgetSection}
Maximum Allowed Scouting Rounds: Up to ${maxRounds}.

### 👑 YOUR FOUR-PHASE ARCHITECTURAL WORKFLOW:

1. **PHASE 1: SCOUTING**:
   - Issue scouting tool calls to gather ground-truth information:
     - \`<sparql query="..." />\` (Architecture graph queries — prefer over grep whenever locating classes, endpoints, or calls)
     - \`<read_definitions path="path/to/file.ext" />\` or \`<get_ast path="..." />\` (Extract symbols/signatures)
     - \`<show_symbol target="path/to/file.ext:SymbolName" />\` (Targeted symbol implementation)
     - \`<peek_files path="path/to/file.ext" lines="30" from="top" />\` (Inspect file slices)
     - \`<read_full_file path="path/to/file.ext" />\` (Inspect complete file)
     - \`<grep query="pattern" path="optional/subfolder" />\` (Search text literals / non-symbol strings)
     - \`<search_memory query="..." />\` (Search project memory)
     - \`<manage_symbols path="path/to/file.ext" activate="SymA, ClassB.methodC" deactivate="UnusedSym" />\` (Batch-activate specific symbols and mute/compact useless symbols in Half-Mute / Structure mode for ANY language: TS, JS, Python, C, C++, Java, Markdown, HTML, etc.)
     - \`<add_files_to_context>path/to/file.ext</add_files_to_context>

\` (Add workspace file to candidate pool)
   - Tool responses accumulate in context across rounds.
   - Early convergence: Stop scouting as soon as you have sufficient certainty!

2. **PHASE 2: UNDERSTANDING (\`<findings>\` = FACTUAL DISCOVERIES ONLY)**:
   - Inside \`<findings>\`, document **ONLY factual discoveries** about the existing codebase: how the system currently works, caller/callee flows, data contracts, and exact file/symbol locations.
   - **STRICT SEPARATION**: NEVER put action items, TODOs, or "what needs to be changed" inside \`<findings>\`. Findings explain *how things work*; \`<phase><instruction>\` states *what to implement*.

3. **PHASE 3: SYMBOL-FIRST VIEWING STRATEGY & CONCRETE TASK INSTRUCTIONS**:
   - Keep the Coder's context as small and focused as possible. **NEVER bloat context with \`mode="full"\` when symbol-level activation suffices**:
     - **Targeted Symbols + Structure (\`mode="symbols"\`, DEFAULT FOR EDITS & INSPECTIONS)**: Load the file's structure/signatures PLUS the exact implementation code of ONLY the symbols (\`symbols="SymbolA,ClassB.methodC"\`) the Coder needs to read or modify. Always prefer this whenever updating specific functions, methods, or classes in existing files!
     - **Structure / Definitions Only (\`mode="structure"\`)**: Load only classes, interfaces, and function signatures without implementation bodies. Use for reference-only files to give 100% type & contract awareness at ~85% token savings.
     - **Full File (\`mode="full"\`, LAST RESORT ONLY)**: Load the entire file content **ONLY when absolutely needed** (e.g., very small files, brand-new files, or files requiring sweeping whole-file structural rewrites that cannot be scoped to symbols).
     - **Muted (\`mode="muted"\`)**: Keep in project tree as reference at 0 tokens.
   - In \`<phase><instruction>\`, write **concrete, self-contained coding instructions** specifying exact target files, exact symbol names to modify/add, exact behavior, and edge cases. **NEVER** write vague delegates like *"implement what was said in the findings"* or *"apply the changes from findings"*.

<plan>
    <findings>
        Factual discoveries only: how the existing system works, execution flow, data contracts, and exact symbol locations. No action items or TODOs here.
    </findings>
    <viewing_strategy>
        <file path="path/to/target.ext" mode="symbols" symbols="targetFunction,TargetClass.handleEvent" justification="Coder only needs to update these two symbols" />
        <file path="path/to/reference.ext" mode="symbols" symbols="validateSession" justification="Need exact implementation of session validation" />
        <file path="path/to/types.ext" mode="structure" justification="Only need type definitions & signatures" />
        <file path="path/to/small_config.json" mode="full" justification="Small file requiring direct full-file edit" />
        <file path="path/to/helper.ext" mode="muted" justification="Not required for this task" />
    </viewing_strategy>
    <phase id="1">
        <instruction>Concrete, self-contained task: In path/to/target.ext, update TargetClass.handleEvent to validate X using validateSession from reference.ext, and add Y error handling in targetFunction.</instruction>
        <files_list>
            path/to/target.ext (symbols: targetFunction, TargetClass.handleEvent)
            path/to/reference.ext (symbols: validateSession)
            path/to/types.ext (structure)
        </files_list>
    </phase>
    <phase id="2">
        <instruction>Detailed technical instructions for Phase 2</instruction>
        <files_list>
            path/to/file3.ext (full)
        </files_list>
    </phase>
</plan>

4. **PHASE 4: CONTEXT SIZE AUDIT & SYMBOL COMPACTION (MANDATORY FINAL CHECK)**:
   - Before finalizing your \`<plan>\`, verify the token sizes of all fully loaded files against the context budget.
   - If any fully loaded file (\`full\`) is bloating the context, **switch it to \`mode="symbols"\` (or \`mode="structure"\`)** and use \`<manage_symbols path="path/to/file.ext" activate="EssentialSym1, Class2.method" deactivate="UselessSym1, UselessSym2" />\` to keep only the required symbols in full and mute/compact useless symbols.
   - This applies across **all file types and languages** (TypeScript, JavaScript, Python, C, C++, Java, Markdown, HTML, Rust, Go, etc.)—not just Python.

5. **PHASE 5: OPTIONAL MEMORY RECORDING**:
   - If you discovered valuable long-term architectural facts, conventions, or design patterns that will benefit future sessions, record them using \`<record_insight topic="..." hashtags="#architecture">...</record_insight>\`.

### 🛑 CRITICAL INVARIANTS:
- Make sure the Coder has every symbol or file it needs before concluding so it never has to stall or complain about missing context.
- Prefer \`mode="symbols"\` over \`mode="full"\` whenever possible; use \`mode="full"\` only when absolutely needed.
- In your \`<files_list>\`, list the real paths (and symbol/structure modes) of all files needed in that phase.
- Output ONLY your tool tags during scouting rounds, and emit the final \`<plan>\` tag when ready.`;
    }

    /**
     * Builds the prompt for compressing earlier chat turns into a high-density recap.
     */
    public static getHistoryCompressionPrompt(transcript: string): string {
        return `You are the Lead Sovereign Context Librarian.
The conversation history has grown large and must be compressed to reserve context budget for code files.
Analyze the following earlier discussion transcript and synthesize a concise, high-density technical recap:
1. **Accomplished**: Key architectural decisions made, files created or modified, and problems resolved.
2. **Current State & Next Steps**: Outstanding tasks, pending requirements, and constraints.

STRICT INSTRUCTIONS:
- Keep the summary under 200 words.
- Format with clear, high-density bullet points.
- Output ONLY the summary text. Do NOT add conversational preamble.

TRANSCRIPT:
${transcript}`;
    }

    public static isGenericWord(w: string): boolean {
        const generic = new Set([
            'the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'will', 'have', 'been', 'should',
            'what', 'when', 'where', 'which', 'who', 'how', 'why', 'can', 'could', 'would', 'into', 'onto',
            'about', 'than', 'then', 'them', 'they', 'their', 'there', 'some', 'any', 'all', 'both', 'each',
            'more', 'most', 'other', 'such', 'only', 'own', 'same', 'so', 'too', 'very', 'just', 'but',
            'because', 'until', 'while', 'out', 'off', 'over', 'under', 'again', 'further', 'once', 'here',
            'few', 'nor', 'not', 'now', 'did', 'didn', 'tried', 'trying', 'says', 'said', 'screen',
            'panel', 'copy', 'folder', 'itryed', 'think', 'still', 'used', 'using', 'also', 'done',
            'does', 'show', 'shows', 'well', 'file', 'files', 'code', 'please', 'help', 'need', 'want',
            'like', 'main', 'fix', 'update', 'change', 'check', 'make', 'look', 'view', 'edit', 'backed',
            'creation', 'legacy', 'system', 'new', 'via', 'get', 'set', 'let', 'var', 'const', 'true', 'false'
        ]);
        return generic.has(w.toLowerCase().trim());
    }

    public static getFindingsSynthesisPrompt(
        prompt: string,
        targetFiles: string[],
        codeSnippets?: string,
        graphSummary?: string
    ): string {
        return `You are the Lead Sovereign Librarian.
The user asked for: "${prompt}"

Target files examined: [${targetFiles.join(', ')}]

${codeSnippets ? `### CODE EXTRACTS:\n${codeSnippets.substring(0, 10000)}\n\n` : ''}
${graphSummary ? `### GRAPH SUMMARY:\n${graphSummary.substring(0, 4000)}\n\n` : ''}

TASK:
Produce an architectural report explaining system mechanics and file interactions:
1. **System & Flow Mechanics**: Trace the complete execution pipeline, caller-callee chains, and how components communicate.
2. **File & Function Breakdown**: For every target file, detail its architectural role, key functions, and side effects.
3. **Contracts, Events & Invariants**: Detail data contracts, schema validations, and state invariants.

Write directly and clearly. Provide focused technical explanations.`;
    }
}