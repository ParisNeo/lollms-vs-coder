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
     - \`<add_files_to_context>path/to/file.ext</add_files_to_context>

\` (Add workspace file to candidate pool)
   - Tool responses accumulate in context across rounds.
   - Early convergence: Stop scouting as soon as you have sufficient certainty!

2. **PHASE 2: UNDERSTANDING**:
   - Reformulate your technical findings into a coherent, clear structure ready for the Coder inside \`<findings>\`.
   - Explain system mechanics, public interfaces, caller/callee flows, and exact contracts discovered.

3. **PHASE 3: WEIGHING FILES & PRODUCING A VIEWING STRATEGY**:
   - Weigh each candidate file based on size (tokens), importance, and task role to form the most token-efficient viewing strategy:
     - **Full File** (\`full\`): Load the entire file content. Use when the Coder must directly write or modify this file, or for small tightly-coupled files.
     - **Structure / Definitions Only** (\`structure\`): Load only classes, interfaces, function signatures, and docstrings without implementation bodies. Saves 80–90% of tokens while giving the Coder 100% type & contract awareness.
     - **Structure + Targeted Real Code** (\`symbols: sym1, Class2:method3\`): Load the file's structure PLUS the exact implementation code of specific functions, methods, or classes needed to understand the mechanics! Saves massive tokens while delivering exact source code where it matters!
     - **Muted** (\`muted\`): Keep in project tree as reference at 0 tokens.
   - Specify your viewing strategy for each file in your plan:

<plan>
    <findings>
        The full findings text organized as markdown with optional code snippets, function contracts, and architecture analysis.
    </findings>
    <viewing_strategy>
        <file path="path/to/target.ext" mode="full" justification="Primary editing target" />
        <file path="path/to/reference.ext" mode="symbols" symbols="validateSession,createSession" justification="Need exact implementation of session creation" />
        <file path="path/to/types.ext" mode="structure" justification="Only need type definitions & signatures" />
        <file path="path/to/helper.ext" mode="muted" justification="Not required for this task" />
    </viewing_strategy>
    <phase id="1">
        <instruction>Detailed technical instructions for Phase 1</instruction>
        <files_list>
            path/to/target.ext (full)
            path/to/reference.ext (symbols: validateSession, createSession)
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

4. **PHASE 4: OPTIONAL MEMORY RECORDING**:
   - If you discovered valuable long-term architectural facts, conventions, or design patterns that will benefit future sessions, record them using \`<record_insight topic="..." hashtags="#architecture">...</record_insight>\`.

### 🛑 CRITICAL INVARIANTS:
- The Coder can ONLY modify files loaded with full content under [C].
- In your \`<files_list>\`, list the real paths of all files that must be modified or read in that phase.
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