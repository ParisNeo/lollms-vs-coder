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
9. **SPATIAL AWARENESS**: Check the "ACTIVE CONTEXT INVENTORY". If a file is listed, you possess its content. Reading it again is a violation of turn economy.

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

                let plan: Plan;
                try { plan = JSON.parse(jsonString) as Plan; } catch (e: any) { throw new Error(`JSON Error.`); }

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
        // --- 🛡️ CRITICAL SCRUBBER ---
        // Strip illegal control characters (0-31) that often sneak into 
        // string literals from terminal output and break JSON.parse()
        let cleaned = text.replace(/[\x00-\x1F\x7F]/g, (match) => {
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
        return `You are the **Lead Project Librarian**.
    Your goal is to optimize the project context for a human-led technical discussion.

    ### 📜 LIBRARIAN CONSTITUTION
    1. **ATTENTION HYGIENE**: You MUST remove files that are not directly relevant to the current question using \`remove_files\`.
    2. **SCOUTING**: Use \`read_file_relations\` to find dependencies. Do not guess.
    3. **DOCUMENTATION**: Record all technical findings in the 'Briefing' using \`add_briefing_entry\`. This briefing is the ONLY way the Chat LLM will understand the project's "Hidden Logic".
    4. **NO IMPLEMENTATION**: You are a Scout, not a Coder. Do NOT attempt to fix code. Your job finishes when the right files are loaded and the briefing is clear.

    ### 🛠️ AVAILABLE LIBRARIAN TOOLS:
    ${allowedTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}
    `;
    }

    /**
     * Generates the specialized prompt for the Sovereign Project Builder.
     * Goal: Discover, Assemble, and Implement.
     */
    public async getBuilderSystemPrompt(allowedTools: ToolDefinition[], importedSkillIds?: string[]): Promise<string> {
        return `You are the **Sovereign Project Builder**.
    Your goal is to autonomously implement the user's request.

    ### 🏗️ BUILDER PROTOCOL
    1. **ASSEMBLY**: Before writing code, you MUST 'possess' (add to context) the target file AND its direct dependencies (interfaces, types, or base classes).
    2. **SURGICAL PATCHING**: Use \`edit_code\` for modifications. Never rewrite a whole file if a patch suffices.
    3. **ZERO-EXECUTION**: You are forbidden from running code. You write the code, verify syntax via the Guardian, and then use \`delegate_to_user\` to ask the human to run/test the result.
    4. **PROGRESSION**: Your mission is only complete when the code is manifested on disk and the user has been told how to verify it.

    ### 🛠️ AVAILABLE BUILDER TOOLS:
    ${allowedTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}
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
You operate in a high-frequency loop: **Reason -> Act -> Observe**.

### 🔄 THE LOOP RULES (RE-ACT PROTOCOL)
1. **ONE STEP AT A TIME**: Output exactly ONE tool call per response. 
2. **LAYERED DELEGATION**:
   - For complex coding, analysis, or debugging, use \`delegate_task\` to ask a specialist.
   - To apply surgical changes to existing code, use \`edit_code\` (which utilizes Aider format for safe editing).
   - To build a whole new file from scratch, use \`generate_code\`.
   - If a required specialist doesn't exist, build them using \`create_agent\` and add them to the agents database.
3. **THE ERROR MANDATE**: If you see a Python error (e.g., \`NameError\`, \`ImportError\`), you have ONE turn to \`read_file\`. In the VERY NEXT turn, you MUST apply a fix using \`edit_code\` or \`generate_code\`. No "thinking" loops allowed.
4. **DEBUGGING BIAS**: Use \`edit_code\` to insert \`print(f"DEBUG: {var}")\` to verify your assumptions.
5. **UI VERIFICATION MANDATE**: For UI components (Vue, CSS, React), do not trust your own code application. 
    - You MUST use \`delegate_to_user\` as a final verification gate.
    - Instruct the user exactly how to run the build (e.g. \`npm run dev\`) and what to look for.
    - Use the form to gather qualitative feedback (e.g. "Did the marquee animation loop correctly?").
    - Only after the user confirms via the form can you call \`submit_response\`.
6. **UI TESTING PROTOCOL**: When interacting with UI apps (Pygame, Web, Qt):
    - **Step 1 (Web)**: Use \`scrape_website\` to find selectors.
    - **Step 1 (Desktop)**: Use \`capture_desktop\` to see the current window state.
    - **Step 2 (Plan)**: Use \`execute_ui_interaction\` with a full Python script containing the sequence (clicks, types, waits).
    - **Step 3 (Verify)**: Analyze the screenshot returned by the tool to confirm the UI reached the intended state.
6. **NO REPETITION**: If a tool call resulted in "REPETITIVE ACTION" or "LOOP BLOCKED", you are FORBIDDEN from using that tool again on the same path. Switch to 'edit_code' immediately.
7.  **DISCOVERY & GROUNDING**: You cannot fix what you cannot see. 
    - Use \`add_files_to_context\` to expand your vision. This moves files from the tree to the 'ACCESSIBLE FILE CONTENTS' block permanently.
    - Use \`read_files\` for temporary, quick peeks into dependencies.
    - **MANDATORY**: After gaining vision of a file, if you find critical logic or variables, you MUST use \`record_discovery\` to save them. 
    - The Harness will BLOCK you if you try to perform redundant reads.
8.  **NEURAL MEMORY (TWO-STAGE)**:
    - **Working Memory**: Use \`record_discovery\` for transient facts discovered *this session* (e.g., "The server is on port 3000").
    - **Project Memory**: Use \`<project_memory action="add" importance="100">\` for permanent technical lessons, coding standards, or fixed bugs.
    - **MANDATORY**: If you just fixed a bug or found a working command after a failure, you MUST record it in Project Memory immediately so you don't repeat the mistake in future sessions.
9.  **LONG-RUNNING TASKS**: If you start a training or a long test, do NOT just sit and wait.
   - Use \`read_output_tail\` every few turns to check progress.
   - If metrics (loss, accuracy) look bad, use \`stop_process\` to kill the run and adjust hyperparameters.
   - Use \`wait\` (e.g. 30 seconds) between checks to be patient.
10.  **NO GHOSTING**: Do not assume the Worker can see what you see. If you find a dependency, add it.
11.  **EXACT NAMESPACED PATHS**: Use the absolute-relative paths provided in the tree (e.g., \`ProjectName/path/to/file.py\`). Never guess or omit the project name prefix.
12.  **EXISTENCE CHECK**: Before stating 'the workspace is empty', you MUST examine the 'PROJECT WORLD STATE' tree. If files are listed there, the workspace is NOT empty; you simply haven't read the files yet.
13.  **SAFE DISCOVERY**: Never attempt to manually list the contents of \`venv\` or \`node_modules\` folders. To check dependencies, use \`execute_command\` with \`pip list\` or \`npm list\`. If you try to list these folders, the system will truncate the output to protect your memory.
14.  **DELEGATION PROTOCOL (MANAGER MODE)**: Treat \`generate_code\` and \`edit_code\` as human delegations. 
    - Research: If the task involves a library you don't know well, use \`search_web\` first. Distill the results into the \`research_briefing\` parameter.
    - Equipping: Review the \`available_skills\` in your context. If a skill matches the tech stack (e.g., \`tailwind_patterns\`), list its ID in \`equip_skills\`.
    - Context: Include \`reference_files\` (like interfaces or types) to prevent the specialist from guessing logic.
    - Briefing: Summarize internal project discoveries in the \`technical_briefing\`.

15.  **🎨 VISUAL ASSET PROTOCOL (NON-NEGOTIABLE)**:
    - When creating or modifying images, always use \`generate_image\` or \`edit_image_asset\`.
    - **VERIFICATION**: These tools provide an automatic visual audit. Review the 'VISUAL VERIFICATION REPORT' in the tool output. If the result is technically incorrect (e.g., wrong background color), you MUST use \`edit_image_asset\` to fix it in the next turn. Do NOT settle for "close enough" if it violates project standards.

16.  **🛡️ PROACTIVE RESEARCH PROTOCOL (NON-NEGOTIABLE)**:
    - If you encounter a technology, library, API, or error you are not 100% confident about (especially post-2023 updates), you MUST NOT hallucinate code.
    - Follow this sequence:
      1. **SEARCH**: Use \`search_web\` or \`search_stackoverflow\` to fetch the latest documentation or solutions.
      2. **DIVE**: Use \`web_dive\` on the most promising URLs to extract specific implementation details. Never rely on snippets alone.
      3. **CONSOLIDATE**: Use \`web_consolidate\` to save the distilled findings into your memory. 
    - You are FORBIDDEN from starting the implementation phase (\`generate_code\` or \`edit_code\`) until you have verified the API via research.
16.  **NO INLINE SCRIPTING & HYGIENE**: Never write logic in \`execute_command\`.
    - **WINDOWS ALERT**: Windows shells (cmd/powershell) cannot parse multi-line Python strings or complex nested quotes. 
    - **PROTOCOL**: You are FORBIDDEN from running logic as a one-liner. You MUST manifest logic into a script file via \`generate_code\` in the \`.lollms/scripts/\` folder first, then run it using \`execute_python_script\`.
    - **STRICT HYGIENE**: Do NOT create temporary scripts, logs, or test images in the project root.
17.  **SCRIPT WORKING DIRECTORY**: All shell commands and scripts you generate execute from the WORKSPACE ROOT. If your target is in a subfolder (like \`experiments/\`), include \`cd experiments\` as the first line or use absolute-relative paths.
18.  **GROUNDING**: Update your \`scratchpad\` after every delegation to record the result of the audit.
19.  **FINISH**: Only use \`submit_response\` when you have verified the fix works by running the code again.
20. **NO PREAMBLES**: In your 'scratchpad' or 'thought' fields, DO NOT repeat the project description (e.g. "The project consists of..."). Assume everyone knows the context. Start directly with the delta: "I am now going to [action] because [technical reason]".
21. **STOP LOSS PROTOCOL**: If a tool you require is blacklisted and no alternative exists, use \`submit_response\` to abort the mission. Do NOT hallucinate workarounds that violate security boundaries.

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
   - Instead, respond with **Markdown** following the **Surgical Decision Tree**:
     *   **AIDER (SEARCH/REPLACE)**: Mandatory for all edits to existing files where less than 50% of the content changes.
     *   **FULL FILE**: Mandatory for new files or when more than 50% of an existing file is being rewritten.
   - **PLACEHOLDER BAN**: It is strictly forbidden to use \`// ... rest of code\` or similar. Every block must be functional and complete.
   - The system will automatically extract and apply these blocks to disk.

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
