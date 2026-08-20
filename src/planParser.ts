import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { stripThinkingTags, getProcessedSystemPrompt } from './utils';
import * as os from 'os';
import { ToolManager } from './tools/toolManager';
import { Plan, ToolDefinition } from './tools/tool';
import { AGENT_MISSION_PROFILES } from './registries/agentProfiles';

export class PlanParser {
    private maxRetries = 3;

    constructor(
        private lollmsApi: LollmsAPI,
        private contextManager: ContextManager,
        private toolManager: ToolManager,
        private skillsManager?: import('./skillsManager').SkillsManager
    ) {}

    public async generateAndParsePlan(
        objective: string,
        existingPlan?: Plan,
        failedTaskId?: number,
        failureReason?: string | null,
        signal?: AbortSignal,
        modelOverride?: string,
        chatHistory: ChatMessage[] = [],
        allowedTools?: ToolDefinition[],
        importedSkills?: string[],
        completedActionsHistory?: string[] 
    ): Promise<{ plan: Plan | null, rawResponse: string, error?: string }> {
        
        const toolsToUse = allowedTools || this.toolManager.getEnabledTools();
        let lastResponse = "";
        let lastError = "";
        
        let messages: ChatMessage[] = [];
        try {
            const systemPromptMessage = await this.getPlannerSystemPrompt(!!existingPlan, toolsToUse, importedSkills);
            messages.push(systemPromptMessage);


            // Construct the memory block
            let memoryBlock = "";
            if (completedActionsHistory && completedActionsHistory.length > 0) {
                memoryBlock = `
# 🕒 PROJECT TIMELINE (DEBUGGING LOG)
The following actions were recently taken. Compare the "Intended Goal" with the "Actual Observation".

${completedActionsHistory.join('\n\n')}

**CRITICAL DIAGNOSTIC**:
- If an action resulted in SUCCESS but the observation shows the screen didn't change as expected (e.g., you clicked but no menu appeared), the previous coordinates were WRONG.
- You MUST adjust your strategy (e.g., different tool, different location, or more discovery) in the next plan.
- DO NOT repeat failed steps with the same parameters.
`;
            }

            if (existingPlan && failedTaskId !== undefined && failureReason) {
                const failureContext = `
${memoryBlock}

**CURRENT STATUS**:
- Original Objective: "${objective}"
- The agent just FAILED at Task ID ${failedTaskId}.
- Error: "${failureReason}"

**INSTRUCTION**:
1. Analyze the failure.
2. Generate a *Revised Plan* that picks up where we left off.
3. **CRITICAL**: Do NOT include steps listed in "COMPLETED ACTIONS" above. Start the plan from the next logical step. Do not repeat work that is already [DONE].
`;
                messages.push({ role: 'user', content: failureContext });
            } else {
                const projectContext = await this.contextManager.getContextContent({ 
                    includeTree: true,
                    importedSkillIds: importedSkills,
                    allowRLM: vscode.workspace.getConfiguration('lollmsVsCoder').get<boolean>('agent.useRLM')
                });
                
            const groundingBlock = `
# 🛠️ PROJECT WORLD STATE (EXISTING STRUCTURE)
${projectContext.projectTree}

**STRICT DISCOVERY PROTOCOL**:
- The tree above is your EYES. If a file is listed in the tree, you ALREADY KNOW it exists.
- DO NOT use \`list_files\` or \`execute_command('ls')\` to check for files present in the tree.
- To see the code inside any file in the tree, use \`read_file\`.

### 📄 ACCESSIBLE FILE CONTENTS
${projectContext.selectedFilesContent || "(No files have been read yet. Use 'read_files' to see code.)"}

${memoryBlock}

# ARCHITECT PROTOCOL (STRICT DELTA):
1. **WORKSPACE RESIDENCY**: You are the resident Lead Architect of this VS Code workspace. Your plan must account for all projects listed in the tree. You are authorized to move or copy files BETWEEN different project roots using namespaced paths (e.g., \`ProjectA/file\` to \`ProjectB/file\`).
2. **DELTA ENFORCEMENT**: Every turn must produce a new technical DELTA. If you fixed a bug, you MUST record it using \`<project_memory action="add" importance="100">\` or \`record_milestone\`. 
3. **NEW FILE PROTOCOL**: When using \`generate_code\`, your specialist MUST provide the full file content. SEARCH/REPLACE is for \`edit_code\` only.
4. **NO AMNESIA**: Review "COMPLETED ACTIONS". If you see you've already tried something, trying it again with the same parameters is a CRITICAL FAILURE.
5. **MILESTONES**: Every time a "Phase" in the logs (e.g., Phase 3: Evaluation) is completed, you MUST call \`record_milestone\` to summarize the technical wins and hurdles.
6. **STRUCTURAL RECONNAISSANCE**: For any task involving more than two files, your FIRST action should be \`read_code_graph(type="summary")\`. This is 10x faster than reading files one-by-one and prevents architectural errors.
7. **RCA**: If the last turn was a FAILURE, your 'scratchpad' MUST begin with "RCA: [Reason why the last step failed]".
8. **JSON ONLY**: Your response must be a single valid JSON object.
9. **GROUNDING MANDATE**: Before using 'read_file' or 'add_files_to_context', you MUST perform a "Context Audit": check the 'ACTIVE CONTEXT INVENTORY' below. If the file is already listed as 'FULL CONTENT LOADED', you are FORBIDDEN from calling the tool.
10. **SPATIAL AWARENESS**: Look at the 'PROJECT WORLD STATE' tree. Markers **[C]** mean the file is already in your memory, formatted inside \`<file path="...">\` XML tags. Reading or adding a **[C]** file is a critical logical failure that wastes tokens.
11. **STRICT COMMENT HYGIENE**: You are STRICTLY FORBIDDEN from adding comment annotations, explanations, or fix logs directly inside the code body (e.g. do NOT write \`# Critical FIX: ...\`). If you need to record a fact or lesson, write a \`<project_memory>\` tag on a new line instead. Keep code clean!

### ⏳ MISSION BUDGET & POCKET PROTECTION
Turns wasted on repetition or broken tools directly decrease your mission score and cost the user money.
1. **ECONOMY**: If a core tool is reported as **FORBIDDEN** due to an infrastructure bug, evaluate if you can pivot to \`execute_command\`.
2. **TERMINATION**: If no workaround exists that respects security rules, you are FORBIDDEN from looping. Use \`submit_response\` to explain the situation and stop.
3. **VALUE**: It is better to admit a limitation than to waste context and compute on a known failing path.
`;
                const historyContext = this.formatHistoryForContext(chatHistory);

                messages.push({ 
                    role: 'user', 
                    content: `${groundingBlock}\n\n${historyContext}**OBJECTIVE:**\n"${objective}"\n\nGenerate the JSON plan.` 
                });
            }
        } catch (e: any) {
            return { plan: null, rawResponse: "", error: `Setup failed: ${e.message}` };
        }

        for (let i = 0; i <= this.maxRetries; i++) {
            try {
                if (signal?.aborted) return { plan: null, rawResponse: "", error: "Aborted" };

                if (i > 0) {
                    messages.push({ role: 'assistant', content: lastResponse });
                    messages.push({ role: 'system', content: `❌ **CRITICAL ERROR: INVALID JSON FORMAT**` });
                }

                lastResponse = await this.lollmsApi.sendChat(messages, null, signal, modelOverride);
                const cleanResponse = stripThinkingTags(lastResponse);
                const jsonString = this.extractJson(cleanResponse);

                if (!jsonString) throw new Error("No valid JSON.");

                let plan: any;
                try {
                    plan = JSON.parse(jsonString);
                } catch (parseErr) {
                    // Fallback: Attempt to extract tool/arguments using Regex if JSON is malformed
                    const toolMatch = jsonString.match(/"name"\s*:\s*"([^"]+)"/);
                    const argsMatch = jsonString.match(/"arguments"\s*:\s*"([\s\S]+?)"\s*}\s*}/);

                    if (toolMatch) {
                        const toolName = toolMatch[1];
                        let params: any = {};
                        if (argsMatch) {
                            const rawArgs = argsMatch[1];
                            try {
                                params = JSON.parse(rawArgs.replace(/\\"/g, '"').replace(/\\n/g, '\n'));
                            } catch {
                                // Extract command directly for poorly-escaped shell commands
                                const cmdMatch = rawArgs.match(/"command"\s*:\s*"([\s\S]+)"/);
                                if (cmdMatch) {
                                    params = { command: cmdMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') };
                                }
                            }
                        }
                        plan = {
                            tool_calls: [{
                                type: 'function',
                                function: {
                                    name: toolName,
                                    arguments: params
                                }
                            }]
                        };
                    } else {
                        throw new Error(`JSON Error.`);
                    }
                }

                this.validateAndInitializePlan(plan, toolsToUse);
                return { plan, rawResponse: lastResponse };

                } catch (error: any) {
                lastError = error.message;
                if (i >= this.maxRetries) return { plan: null, rawResponse: lastResponse, error: `Failed.` };
            }
        }
        return { plan: null, rawResponse: lastResponse, error: "Failed." };
    }

    private formatHistoryForContext(history: ChatMessage[]): string {
        if (!history || history.length === 0) return "";
        let text = "## PREVIOUS CONVERSATION HISTORY\n\n";
        for (const msg of history) {
            if (msg.role === 'system') continue; 
            let contentStr = Array.isArray(msg.content) ? msg.content.map(c => c.type === 'text' ? c.text : '[Image]').join('\n') : String(msg.content);
            if (contentStr.length > 2000) contentStr = contentStr.substring(0, 2000) + "...";
            text += `**${msg.role.toUpperCase()}**: ${contentStr}\n\n`;
        }
        return text + "---\n\n";
    }

    public validateAndInitializePlan(plan: any, allowedTools: ToolDefinition[]): void {
        if (!plan || typeof plan !== 'object') throw new Error("Not an object.");

        // --- POLYMORPHIC PARSING LAYER ---
        // 1. Handle native tool_calls format
        if (plan.tool_calls && Array.isArray(plan.tool_calls)) {
            plan.tasks = plan.tool_calls.map((tc: any, idx: number) => {
                let params = {};
                if (tc.function?.arguments) {
                    if (typeof tc.function.arguments === 'string') {
                        try {
                            params = JSON.parse(tc.function.arguments);
                        } catch (e) {
                            // Recover unescaped commands
                            const argStr = tc.function.arguments;
                            const cmdMatch = argStr.match(/"command"\s*:\s*"([\s\S]+?)"/);
                            if (cmdMatch) {
                                params = { command: cmdMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') };
                            } else {
                                params = { raw: argStr };
                            }
                        }
                    } else if (typeof tc.function.arguments === 'object') {
                        params = tc.function.arguments;
                    }
                }
                return {
                    id: idx + 1,
                    task_type: 'simple_action',
                    description: `Executing tool ${tc.function?.name || 'unknown'}`,
                    action: tc.function?.name,
                    parameters: params,
                    status: 'pending',
                    result: null,
                    retries: 0
                };
            });
        }
        // 2. Handle root-level single tool format
        else if (plan.tool && !plan.tasks) {
            plan.tasks = [{
                id: 1,
                task_type: 'simple_action',
                description: plan.thought || plan.new_remark || "Executing tool...",
                action: plan.tool,
                parameters: plan.params || {},
                status: 'pending',
                result: null,
                retries: 0
            }];
        }

        if (!plan.tasks) {
            if (plan.steps && Array.isArray(plan.steps)) plan.tasks = plan.steps;
            else if (plan.plan && Array.isArray(plan.plan)) plan.tasks = plan.plan;
        }
        if (!plan.tasks || !Array.isArray(plan.tasks)) throw new Error("Missing tasks.");
        
        const validToolNames = new Set(allowedTools.map(t => t.name));
        const seenTasks = new Set<string>();
        
        for (const task of plan.tasks) {
            if (!task.action) throw new Error("Task missing action.");
            if (!validToolNames.has(task.action)) throw new Error(`Tool '${task.action}' unknown.`);
            
            // INTRA-PLAN DEDUPLICATION
            const taskFingerprint = `${task.action}:${JSON.stringify(task.parameters)}`;
            if (seenTasks.has(taskFingerprint)) {
                throw new Error(`REDUNDANT PLAN: Task '${task.action}' with these parameters is listed twice in your plan. Be incremental.`);
            }
            seenTasks.add(taskFingerprint);

            task.status = 'pending';
            task.result = null;
            task.retries = 0;
            if (!task.dependencies) task.dependencies =[]; // Normalize to empty array
        }
    }

    public extractJson(text: string): string | null {
        // --- 🛡️ THINKING MODEL SAFETY SHIELD ---
        // Pre-strip any thinking tags (<think>...</think>) before extracting JSON structure
        const strippedText = stripThinkingTags(text);

        // --- 🛡️ CRITICAL SCRUBBER ---
        // Strip illegal control characters (0-31) that often sneak into 
        // string literals from terminal output and break JSON.parse()
        let cleaned = strippedText.replace(/[\x00-\x1F\x7F]/g, (match) => {
            if (match === '\n') return '\n';
            if (match === '\r') return '\r';
            if (match === '\t') return '\t';
            return ''; // Remove all others
        }).trim();

        // 1. Strongest: Markdown block
        const markdownMatch = cleaned.match(/```json\s*([\s\S]+?)\s*```/);
        if (markdownMatch) return markdownMatch[1].trim();

        // 2. Robust: Find outermost braces
        let braceCount = 0;
        let startIndex = cleaned.indexOf('{');
        if (startIndex === -1) return null;

        let result = null;

        for (let i = 0; i < cleaned.length; i++) {
            if (cleaned[i] === '{') {
                if (braceCount === 0) startIndex = i;
                braceCount++;
            } else if (cleaned[i] === '}') {
                braceCount--;
                if (braceCount === 0 && startIndex !== -1) {
                    const potential = cleaned.substring(startIndex, i + 1);
                    // Check if it's likely a tool call or plan
                    if (potential.includes('"tool"') || potential.includes('"tasks"') || potential.includes('"action"')) {
                        result = potential;
                        break; // Take the first valid structural object
                    }
                }
            }
        }

        // 4. Final attempt: If LLM cut off the closing braces, try to append them
        // This is a "hail mary" for truncated server responses
        if (!result && startIndex !== -1 && braceCount > 0) {
            // If it ends mid-string, try to close the string first
            let attempt = cleaned.substring(startIndex);
            if (attempt.split('"').length % 2 === 0) { 
                attempt += '"'; 
            }
            attempt += "}".repeat(braceCount);
            
            try {
                JSON.parse(attempt);
                result = attempt;
            } catch (e) {}
        }

        return result;
    }

    /**
     * Generates the specialized prompt for the Lead Project Librarian.
     * Goal: Scout and prepare context for the Discussion LLM.
     */
    public async getLibrarianSystemPrompt(allowedTools: ToolDefinition[], importedSkillIds?: string[]): Promise<string> {
        const { ChatPanel } = require('./commands/chatPanel/chatPanel');
        const activeDiscussion = ChatPanel.currentPanel?.getCurrentDiscussion();
        const sparqlEnabled = activeDiscussion?.capabilities?.sparqlEnabled !== false;

        let graphSection = `
    ### 📊 SOVEREIGN CODE GRAPH & PATTERNS
    - **GRAPH-DRIVEN DISCOVERY (MANDATORY)**: You MUST consult the **Architecture Graph** (\`read_code_graph\` or \`query_architecture\`) before blindly reading files or running text searches. The graph is the absolute source of truth for the project's class hierarchies, call patterns, and module dependencies.
    - **ONTOLOGY ALIGNMENT**: Use SPARQL-lite queries on \`query_architecture\` to map out exactly which files import a library or call a target method. This is 10x faster than raw content grep and protects your attention map.
        `;

        if (!sparqlEnabled) {
            graphSection = "";
        }

        const constitutionLines = [
            "1. **SPATIAL AWARENESS (MANDATORY)**: Before asking for a file, look at the tree. If it is marked **[C]**, you ALREADY possess it. Asking for it again is a system violation.",
            "2. **ATTENTION HYGIENE**: You MUST remove files that are not directly relevant to the current question using \`remove_files\`."
        ];

        if (sparqlEnabled) {
            constitutionLines.push("3. **SCOUTING**: Use \`read_file_relations\` or SPARQL queries to find dependencies. Do not guess.");
            constitutionLines.push("4. **TOOL HYGIENE**: You are STRICTLY FORBIDDEN from calling non-existent tools like \`list_files\`, \`list_dir\`, or raw directory listings. The file tree provided in your context contains the entire codebase structure. Use the Code Graph or \`query_architecture\` if you need structural information.");
        } else {
            constitutionLines.push("3. **SCOUTING**: Use \`read_file_relations\` to find dependencies. Do not guess.");
            constitutionLines.push("4. **TOOL HYGIENE**: You are STRICTLY FORBIDDEN from calling non-existent tools like \`list_files\`, \`list_dir\`, or raw directory listings. The file tree provided in your context contains the entire codebase structure.");
        }

        constitutionLines.push("5. **DOCUMENTATION**: Record all technical findings in the 'Briefing' using \`add_briefing_entry\`. This briefing is the ONLY way the Chat LLM will understand the project's \"Hidden Logic\".");
        constitutionLines.push("6. **NO IMPLEMENTATION**: You are a Scout, not a Coder. Do NOT attempt to fix code. Your job finishes when the right files are loaded and the briefing is clear.");

        const filteredTools = sparqlEnabled ? allowedTools : allowedTools.filter(t => t.name !== 'query_architecture' && t.name !== 'read_code_graph');

        return `You are the **Lead Project Librarian**.
    Your goal is to optimize the project context and build the technical briefing for the team.
    ${graphSection}
    ### 🧠 NEURAL MEMORY INTEGRATION (TIERED KNOWLEDGE)
    - **ENGRAMS & SKILLS**: When you discover a project-specific standard, library quirk, or crucial dependency relation, do NOT let it get lost in chat history. You MUST use \`store_knowledge\` or write a \`<project_memory action="add">\` tag to save it to our **Tiered Neural Memory System**.
    - **HYDRATION**: Search through latent memory handles and promote relevant skills or legacy engrams to active working memory to keep the context grounded.

    ### 📜 LIBRARIAN CONSTITUTION
    ${constitutionLines.join('\n    ')}

    ### 🛠️ AVAILABLE LIBRARIAN TOOLS:
    ${filteredTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}
    `;
    }

    /**
     * Generates the specialized prompt for the Sovereign Project Builder.
     * Goal: Discover, Assemble, and Implement.
     */
    public async getBuilderSystemPrompt(allowedTools: ToolDefinition[], importedSkillIds?: string[]): Promise<string> {
        const { ChatPanel } = require('./commands/chatPanel/chatPanel');
        const activeDiscussion = ChatPanel.currentPanel?.getCurrentDiscussion();
        const sparqlEnabled = activeDiscussion?.capabilities?.sparqlEnabled !== false;

        let graphSection = `
    ### 📊 GRAPH-BASED ARCHITECTURE AWARENESS
    - **NO ISOLATED CODE**: You are forbidden from modifying files without understanding their structural neighborhood. You MUST consult the **Sovereign Code Graph** (\`read_code_graph\` or \`query_architecture\`) before creating new files or changing existing methods to ensure your implementation perfectly aligns with the project's design patterns and doesn't introduce duplicate classes or circular imports.
        `;

        if (!sparqlEnabled) {
            graphSection = "";
        }

        const filteredTools = sparqlEnabled ? allowedTools : allowedTools.filter(t => t.name !== 'query_architecture' && t.name !== 'read_code_graph');

        return `You are the **Sovereign Project Builder**.
    Your goal is to autonomously implement the user's request.
    ${graphSection}
    ### 🧠 NEURAL MEMORY PERFUSION
    - **FACT PERSISTENCE**: Every time you resolve a compiler error, configure a new dependency, or establish a coding standard, you MUST save this rule into the **Sovereign Memory Vault** using a \`<project_memory action="add" importance="100">\` tag. This ensures your learnings survive across turns and are immediately available to other sub-agents.
    - **SKILL PROJECTION**: Search and use the active skills in your memory context to write safe, clean, idiomatic code that respects the project's DNA.

    ### 🛠️ ERROR RECOVERY & JSON HYGIENE
    - **STRICT SINGLE-TOOL RULE**: You are FORBIDDEN from outputting multiple JSON blocks in a single response. You must output exactly ONE valid JSON object per turn representing your next technical step.
    - If you receive an "Unknown tool" error, DO NOT repeat the call. Check the 'AVAILABLE TOOLS' list below and pivot to a different strategy (e.g., use 'execute_command' to run 'ls' or 'grep').
    ${sparqlEnabled ? "- If you are stuck in a loop, use 'read_code_graph' to reset your awareness." : ""}
    - **JSON ESCAPING MANDATE**: When outputting tool parameters containing newlines, quotes, or backslashes, you MUST escape them correctly. Do NOT write raw unescaped newlines or double quotes inside a JSON string value, as this causes parser failures like "Unterminated string in JSON".

    ### 🏗️ BUILDER PROTOCOL
    1. **ASSEMBLY**: Before writing code, you MUST 'possess' (add to context) the target file AND its direct dependencies (interfaces, types, or base classes).
    2. **SURGICAL PATCHING**: Use \`edit_code\` for modifications. Never rewrite a whole file if a patch suffices.
    3. **ZERO-EXECUTION**: You are forbidden from running code. You write the code, verify syntax via the Guardian, and then use \`delegate_to_user\` to ask the human to run/test the result.
    4. **PROGRESSION**: Your mission is only complete when the code is manifested on disk and the user has been told how to verify it.

    ### 🛠️ AVAILABLE BUILDER TOOLS:
    ${filteredTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}
    `;
    }

    public async getArchitectSystemPrompt(allowedTools: ToolDefinition[], importedSkillIds?: string[], specialistsList?: string[], env?: any): Promise<ChatMessage> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const agentPersona = config.get<string>('agentPersona') || "You are an autonomous AI Agent.";

        // 1. Fetch the dynamic list of profiles from settings
        const userProfiles = config.get<any[]>('agentProfiles') || [];

        // 2. Identify the active one (prioritize discussion-specific override from the UI badge)
        const discussionProfileId = env?.agentManager?.getCurrentDiscussion()?.capabilities?.activeAgentProfileId;
        const activeProfileId = discussionProfileId || (this as any)._activeProfileOverride || config.get<string>('agent.activeProfile') || 'software_architect';
        const profile = userProfiles.find(p => p.id === activeProfileId) || userProfiles[0];
        const profileProtocol = profile ? profile.protocol : "";

        // We pass 'agent' type to get formatting rules for AIDER and Code Generation
        const baseSystemInfo = await getProcessedSystemPrompt('agent', undefined, agentPersona);

        const errorManagementProtocol = `
### 🛡️ ERROR & LOOP PREVENTION PROTOCOL
1. **THE FAILURE RULE**: If your last action was a FAILURE, your next 'thought' MUST start with: "RCA: [Reason why it failed]".
2. **THE REPETITION RULE**: If you receive a "LOOP BLOCKED" error, you have lost your 'intuition' for this path. You MUST switch to 'Discovery Mode': use 'read_file' on a file you haven't looked at yet or 'execute_command' to run a diagnostic (like 'ls' or 'pwd').
3. **NO GHOST RETRIES**: Never assume a tool failed because of a "glitch". Tools fail because your parameters or your understanding of the file system are incorrect.
`;

        const session = (env?.agentManager?.sessionState as any) || {};
        // If no explicit active IDs, default all tools to active (for new sessions)
        const activeIds = session.activeToolIds || new Set(allowedTools.filter(t => t.isDefault).map(t => t.name));

        const activeTools = allowedTools.filter(t => activeIds.has(t.name));
        const latentTools = allowedTools.filter(t => !activeIds.has(t.name));

        const toolDescriptions = activeTools.map(tool => {
            let desc = tool.description;
            if (tool.name === 'delegate_task' && specialistsList && specialistsList.length > 0) {
                desc += ` (Available Specialist IDs: [${specialistsList.join(', ')}])`;
            }
            const params = tool.parameters.map(p => `"${p.name}" (${p.type}): ${p.description}`).join(', ');
            return `- **${tool.name}**: ${tool.description} (Params: ${params})`;
        }).join('\n');

        const latentCatalogue = latentTools.length > 0 
            ? `\n### 📦 LATENT TOOL CATALOGUE (Equip via manage_tools)\n` + 
              latentTools.map(t => `- ${t.name}: ${t.description.split('.')[0]}.`).join('\n')
            : "";

        const skillsDesc = (importedSkillIds && importedSkillIds.length > 0) 
            ? importedSkillIds.map(id => `- ${id}`).join('\n')
            : "- No specific skills imported.";

        const content = `${baseSystemInfo}

        # 🧞 THE GENIE PROTOCOL (RE-ACT)
        ${profileProtocol}
You are a **Project Manager (Lead Architect)** with high-level vision of the project.
You practice **Layered Agentic Development**. This means you delegate specific tasks to **Specialists** who are well-conditioned for their roles, while maintaining complete project overview.
You operate in a high-frequency autonomous loop with conditions: **Reason -> Act -> Observe -> Test/Verify -> Debug -> Conclude**.

### 🔄 THE CONDITIONAL AUTONOMOUS LOOP RULES (RE-ACT PROTOCOL)
1. **ONE STEP AT A TIME**: Output exactly ONE tool call per response. 
2. **THE 5-PHASE CONDITIONAL CYCLE**:
   - **Phase 1: Discovery & Context Gathering**: Use \`read_file\` or \`query_architecture\` to inspect relevant symbols.
   - **Phase 2: Code Implementation**: Use \`edit_code\`, \`update_function\`, or \`generate_code\` to manifest code changes.
   - **Phase 3: Execution & Testing**: You MUST run tests or execution commands (\`execute_command\`, \`run_file\`, \`execute_python_script\`, \`run_tests_and_fix\`).
   - **Phase 4: Conditional Evaluation & Debug**:
     * **IF TESTS/RUN FAIL**: Analyze the error output, formulate a hypothesis, apply surgical fixes or instrumentation, and loop back to Phase 3.
     * **IF TESTS/RUN PASS**: Confirm all acceptance criteria are met, record learnings/milestones, and move to Phase 5.
   - **Phase 5: Conclude**: Once verified, call \`submit_response\` with a concise summary of the resolved task.
3. **READ-ONLY DOCUMENT & BINARY ARTIFACTS**:
   - Files like \`.pdf\`, \`.docx\`, \`.xlsx\`, \`.pptx\`, \`.ipynb\`, \`.png\`, \`.jpg\`, \`.bin\` contain extracted read-only text in context.
   - You are **FORBIDDEN** from editing or patching these binary documents with code blocks or \`edit_code\`.
   - To modify spreadsheets/documents, generate and run a Python script with \`pandas\`, \`openpyxl\`, or \`python-docx\`.
4. **GIT & BRANCH ISOLATION**:
   - Git repository state is checked at mission start.
   - Any dirty working directory is cleaned (stashed/committed) and checked out to an isolated task branch.
5. **BUDGET CONTROL & TERMINATION**:
   - Track your step and token budgets. If turns are running out, do not start new explorations; finalize your code and submit the result.
6. **THE ERROR MANDATE**: If you see a compiler, syntax, or runtime error, analyze the failure in your next turn and immediately apply a surgical fix.
7. **NO REPETITION**: If a tool call fails or is redundant, you are FORBIDDEN from repeating the same parameters. Alter your approach or change tools.
8. **DISCOVERY & GROUNDING**:
   - Use \`add_files_to_context\` to expand your vision when new files are required.
   - Use \`record_discovery\` to save critical facts to working memory.
9. **NEURAL MEMORY**:
   - Use \`<project_memory action="add" importance="100">\` for permanent technical lessons, coding standards, or fixed bugs.
10. **SCRIPT WORKING DIRECTORY**: Commands and scripts execute from the WORKSPACE ROOT. Use relative paths or \`cd\` appropriately.
11. **FINISH**: Call \`submit_response\` once the condition is verified.

### 🛠️ ACTIVE TOOLS (Equipped)
${toolDescriptions}

${latentCatalogue}

${errorManagementProtocol}

### 💡 SKILLS & CONTEXT
${skillsDesc}

### 🛑 RESPONSE PROTOCOL & FORMAT (CRITICAL)
You have two modes of operation:

1. **TOOL MODE (Planning/Discovery)**:
   - Output ONLY a valid JSON object.
   - Use this for navigation, reading files, searching, or terminal commands.
\`\`\`json
{
"new_remark": "I found that the config.json uses a different port than expected.",
"current_sub_goal": "Re-run the server on port 8081",
"tool": "tool_name",
"params": { ... }
}
\`\`\`

2. **CODING MODE (Implementation)**:
   - If the task is to **write or edit code**, do NOT wrap the code in a JSON string.
   - Instead, output structured XML **\`<file path="..." action="write|patch|update_symbol">\`** tags:
     *   **action="patch"**: Use Aider SEARCH/REPLACE blocks for surgical modifications to existing files.
     *   **action="write"**: Output the complete file content from line 1 to the end for new files or major rewrites.
     *   **action="update_symbol" symbol="..."**: Output standalone function/class replacements.
   - Standard markdown code blocks (\`\`\`python ... \`\`\`) are reserved for informational display only.

- **MILESTONES**: Every time you fulfill a major sub-objective, the system updates your progress.
- **NO REDUNDANCY**: Focus only on the current technical step.
`;
        return { role: 'system', content };
    }

    public async getPlannerSystemPrompt(isRevision: boolean = false, allowedTools: ToolDefinition[], importedSkills?: string[]): Promise<ChatMessage> {
        // To ensure the planner uses the UI-selected profile, we pass the current discussion context
        const { ChatPanel } = require('./commands/chatPanel/chatPanel');
        const activeDiscussion = ChatPanel.currentPanel?.getCurrentDiscussion();

        const dummyEnv: any = { 
            agentManager: { 
                getCurrentDiscussion: () => activeDiscussion 
            } 
        };

        return this.getArchitectSystemPrompt(allowedTools, importedSkills, undefined, dummyEnv);
    }
}
