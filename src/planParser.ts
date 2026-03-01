import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { stripThinkingTags, getProcessedSystemPrompt } from './utils';
import * as os from 'os';
import { ToolManager } from './tools/toolManager';
import { Plan, ToolDefinition } from './tools/tool';

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
# 🧠 COMPLETED ACTIONS MEMORY
The following actions have ALREADY been successfully executed in this session.
**DO NOT** include these in the new plan unless you explicitly intend to redo them (e.g. rewrite a file).
${completedActionsHistory.map(a => `- [DONE] ${a}`).join('\n')}
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
# PROJECT WORLD STATE
${projectContext.text}

${memoryBlock}

# ARCHITECT PROTOCOL:
1. **MEMORY ENFORCEMENT**: Check "COMPLETED ACTIONS". Do not repeat work.
2. **KNOWLEDGE ZONES**: Use \`store_knowledge\` for important facts.
3. **JSON ONLY**: Your response must be a single valid JSON object.
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
        
        for (const task of plan.tasks) {
            if (!task.action) throw new Error("Task missing action.");
            if (!validToolNames.has(task.action)) throw new Error(`Tool '${task.action}' unknown.`);
            task.status = 'pending';
            task.result = null;
            task.retries = 0;
            if (!task.dependencies) task.dependencies =[]; // Normalize to empty array
        }
    }

    public extractJson(text: string): string | null {
        let cleaned = text.trim();
        
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
        if (!result && startIndex !== -1 && braceCount > 0) {
            let attempt = cleaned.substring(startIndex) + "}".repeat(braceCount);
            try {
                JSON.parse(attempt);
                result = attempt;
            } catch (e) {}
        }

        return result;
    }

    public async getArchitectSystemPrompt(allowedTools: ToolDefinition[], importedSkillIds?: string[]): Promise<ChatMessage> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const modelPool = config.get<any[]>('herdDynamicModelPool') ||[];
        const poolDesc = modelPool.map(m => `- \`${m.model}\`: ${m.description}`).join('\n');

        let skillsDesc = "- No specific skills have been selected by the user for this discussion.";
        if (this.skillsManager) {
            const activeProjectSkills = await this.contextManager.getActiveProjectSkills();
            const allActiveSkillIds = Array.from(new Set([...(importedSkillIds || []), ...activeProjectSkills]));
            
            if (allActiveSkillIds.length > 0) {
                const allSkills = await this.skillsManager.getSkills();
                const activeSkills = allSkills.filter(s => allActiveSkillIds.includes(s.id));
                if (activeSkills.length > 0) {
                    skillsDesc = activeSkills.map(s => `- \`${s.id}\`: ${s.name} (${s.description})`).join('\n');
                }
            }
        }

        const baseSystemInfo = await getProcessedSystemPrompt('agent');
        const toolDescriptions = allowedTools.map(tool => {
            const params = tool.parameters.map(p => `"${p.name}" (${p.type}): ${p.description}`).join(', ');
            return `- **${tool.name}**: ${tool.description} (Params: ${params})`;
        }).join('\n');

        const content = `${baseSystemInfo}

You are the **Lead Architect & Autonomous Orchestrator**. You manage a team of multi-agent specialists to solve highly complex, open-ended requests (e.g., "Build a ROS node", "Train a VAE on this data and generate a PDF report").

### 🔍 PHASE 1: DISCOVERY & REFRAMING (CRITICAL FOR COMPLEX TASKS)
If the request requires exploring code, data, or system environments, **DO NOT output a JSON plan immediately.**
Instead, use tools directly to explore the environment.
- **Resuming Work**: If the user asks to resume, continue, or fix an ongoing project, use \`execute_command\` (e.g., \`ls -la\`, \`git status\`) and \`read_file\` to thoroughly inspect the current state BEFORE planning. Check what has already been built.
- **Environment Intelligence**: Look for existing virtual environments (e.g., \`.venv\`, \`venv\`, \`node_modules\`). Do NOT destructively overwrite them.
- Output a SINGLE JSON tool call (e.g., \`execute_command\`, \`read_file\`, \`search_files\`).
- I will execute it and return the output. You can loop this as many times as needed to learn.
- If the task is complex, you may use the \`submit_response\` tool during this phase to summarize to the user what you understood and what your strategy will be.

### 🛡️ PHASE 2: PLANNING, DELEGATION & EXECUTION
Once you fully understand the environment, output your execution plan.
- Break the objective into tasks.
- **Multi-Agent Delegation**: Assign specific expert personas via the \`agent_persona\` field (e.g., "You are a Senior ROS Engineer", "You are an ML Data Scientist") and choose appropriate models.
- **Verification Loop**: Your plan MUST include execution and validation steps. After writing code, use \`execute_command\` or \`execute_python_script\` to run it.
- **Iterative Enhancement**: If an execution task fails, I will wake you up with the error. You must generate a *Revised Plan* to debug, edit the code, and test again until satisfactory.
- **Artifacts**: If asked for a PDF or report, write a python script that generates it (using libraries like \`fpdf\`, \`reportlab\`, or \`matplotlib\` for data), install the dependencies, and execute it.

### 💻 PLATFORM AWARENESS
- OS Platform: ${os.platform() === 'win32' ? 'Windows' : os.platform()}
- **Shell Commands**: You MUST adapt \`execute_command\` to the OS. On Windows, use PowerShell syntax (\`Get-ChildItem\`, \`curl.exe\`). On Linux/Mac, use Bash. Terminals ARE visible to the user.

### 👥 MULTI-AGENT MODEL POOL
You can assign these models to tasks:
${poolDesc || "- No specific pool: Use default model for all tasks."}

### 💡 AVAILABLE SKILLS (USER SELECTED)
You can ONLY equip sub-agents with the following specific skills requested by the user:
${skillsDesc}

### ⚡ CONCURRENT EXECUTION
- Tasks with \`"dependencies":[]\` run immediately in parallel.
- Use dependencies to sequence logic (e.g., test only after coding finishes).

### TOOLS:
${toolDescriptions}

### FINAL OUTPUT FORMAT:
If you are still investigating, output ONLY the tool JSON. 
If you are ready to execute the sequence, output ONLY the Plan JSON:
\`\`\`json
{
  "objective": "...",
  "scratchpad": "Your reasoning, strategy, and what you discovered...",
  "tasks":[
    { 
      "id": 1, 
      "action": "tool_name", 
      "description": "What this sub-agent will do...",
      "parameters": {},
      "dependencies": [],
      "model": "optional_model_id",
      "agent_persona": "Specific instructions for the sub-agent executing this task",
      "agent_skills": ["skill_id_1"],
      "agent_files":["src/main.py", "src/utils.py"]
    }
  ]
}
\`\`\`
`;
        return { role: 'system', content };
    }

    public async getPlannerSystemPrompt(isRevision: boolean = false, allowedTools: ToolDefinition[], importedSkills?: string[]): Promise<ChatMessage> {
        return this.getArchitectSystemPrompt(allowedTools, importedSkills);
    }
}
