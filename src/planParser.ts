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
        private toolManager: ToolManager
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
        importedSkills?: string[]
    ): Promise<{ plan: Plan | null, rawResponse: string, error?: string }> {
        
        const toolsToUse = allowedTools || this.toolManager.getEnabledTools();

        let lastResponse = "";
        let lastError = "";
        
        let messages: ChatMessage[] = [];
        try {
            const systemPromptMessage = await this.getPlannerSystemPrompt(!!existingPlan, toolsToUse);
            messages.push(systemPromptMessage);

            if (existingPlan && failedTaskId !== undefined && failureReason) {
                const failureContext = `The original objective was: "${objective}".
We were executing a plan, but task ${failedTaskId} returned this result:
---
${failureReason}
---
The user needs you to interpret this result or fix the error. Generate a NEW plan fragment to finish the objective.`;
                messages.push({ role: 'user', content: failureContext });
            } else {
                const projectContext = await this.contextManager.getContextContent({ 
                    includeTree: true,
                    importedSkillIds: importedSkills
                });
                
                const groundingBlock = `
# PROJECT WORLD STATE
Current environment and files:
${projectContext.text}

# ARCHITECT PROTOCOL:
1. Output ONLY the JSON plan.
2. Every plan MUST end with \`submit_response\`.
3. **SKILLS ADHERENCE**: If a Skill (e.g. Moltbook) is present in the context, your plan MUST implement the specific logic and security rules defined in that skill.
4. **DO NOT USE TEMPLATES**: Do NOT use syntax like \`{{ ... | regex_search ... }}\`. You CANNOT perform parsing in the final response.
5. **INTELLIGENT PARAMETERS**: If you just performed research (like \`research_web_page\`), look at the output in the history. Craft your next tasks using the SPECIFIC details found. For example, if you found book themes, use them in the 'content' parameter of the post.
6. **NO REDUNDANCY**: Check the conversation history. If a task has already been successfully completed (e.g., website scraped), DO NOT plan it again. Move to the next logical step.
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
                    const correctionPrompt = { 
                        role: 'system' as const, 
                        content: `❌ **CRITICAL ERROR: INVALID JSON FORMAT**` 
                    };
                    messages.push({ role: 'assistant', content: lastResponse });
                    messages.push(correctionPrompt);
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
        let text = "## PREVIOUS CONVERSATION HISTORY (Check this to avoid repeats)\n\n";
        for (const msg of history) {
            if (msg.role === 'system') continue; 
            let contentStr = Array.isArray(msg.content) ? msg.content.map(c => c.type === 'text' ? c.text : '[Image]').join('\n') : String(msg.content);
            if (contentStr.length > 3000) contentStr = contentStr.substring(0, 3000) + "...";
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
        }

        // ENFORCEMENT: Ensure the plan ends with 'submit_response'
        if (plan.tasks.length > 0) {
            const lastTask = plan.tasks[plan.tasks.length - 1];
            if (lastTask.action !== 'submit_response' && validToolNames.has('submit_response')) {
                plan.tasks.push({
                    id: Math.max(...plan.tasks.map((t: any) => t.id)) + 1,
                    task_type: 'simple_action',
                    action: 'submit_response',
                    description: 'Report completion to the user.',
                    parameters: { response: "All tasks completed successfully." },
                    status: 'pending',
                    result: null,
                    retries: 0
                });
            }
        }
    }

    public extractJson(text: string): string | null {
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            const candidate = text.substring(firstBrace, lastBrace + 1);
            if (candidate.includes('"tasks"') || candidate.includes('"steps"')) return candidate;
        }
        const markdownMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
        if (markdownMatch) return markdownMatch[1].trim();
        return null;
    }

    public async getArchitectSystemPrompt(allowedTools: ToolDefinition[]): Promise<ChatMessage> {
        const baseSystemInfo = await getProcessedSystemPrompt('agent');
        const toolDescriptions = allowedTools.map(tool => {
            const params = tool.parameters.map(p => `"${p.name}" (${p.type}): ${p.description}`).join(', ');
            return `- **${tool.name}**: ${tool.description} (Params: ${params})`;
        }).join('\n');

        const content = `${baseSystemInfo}

You are the **Architect Agent**. 

### TOOL USAGE PROTOCOL
1. **USE NATIVE TOOLS**: Always prefer \`moltbook_action\`, \`read_file\`, \`search_web\` over writing python scripts (\`generate_code\`). Only write scripts if no tool exists.
2. **CHECK HISTORY**: Before adding a task, check the conversation history. If the user or a previous tool already provided the information, DO NOT run the tool again.
3. **MOLTBOOK & SKILLS**: If a Skill (Moltbook) is present, use its API via \`moltbook_action\`. Do not write python scripts to hit the API unless explicitly requested.

### PHASE 1: INVESTIGATION (Optional)
If you need more information about the codebase (files, structure, definitions) or environment to build a correct plan:
- Use available tools like \`list_files\`, \`read_file\`, \`search_files\`, \`rlm_repl\`, \`moltbook_action\`, \`wait\`, \`analyze_image\`, or \`research_web_page\`.
- To call a tool, output a **JSON** block with the "tool" and "params" keys.

### PHASE 2: PLANNING (Mandatory Final Step)
Once you have sufficient information:
- Output the **FINAL PLAN** as a JSON object containing the "tasks" array.
- Use the **SPECIFIC DATA** gathered during Phase 1 to populate task parameters.
- **MANDATORY**: The very last task in your plan MUST be \`submit_response\` to inform the user.

### Tools Available:
${toolDescriptions}

### Final Plan Format:
\`\`\`json
{
  "objective": "...",
  "scratchpad": "Summary of findings and strategy...",
  "tasks": [
    { "id": 1, "task_type": "simple_action", "action": "...", "description": "...", "parameters": {} },
    ...
    { "id": N, "task_type": "simple_action", "action": "submit_response", "description": "Done", "parameters": { "response": "..." } }
  ]
}
\`\`\`
`;
        return { role: 'system', content };
    }

    public async getPlannerSystemPrompt(isRevision: boolean = false, allowedTools: ToolDefinition[]): Promise<ChatMessage> {
        const baseSystemInfo = await getProcessedSystemPrompt('agent');
        const toolDescriptions = allowedTools.map(tool => {
            const params = tool.parameters.map(p => `"${p.name}" (${p.type}): ${p.description}`).join(', ');
            return `- **${tool.name}**: ${tool.description} (Params: ${params})`;
        }).join('\n');

        const content = `${baseSystemInfo}

You are the **Plan Architect**. 

### MANDATORY CONSTRAINTS:
1. **JSON ONLY**: Your response MUST be a single JSON object.
2. **USE NATIVE TOOLS**: Prefer \`moltbook_action\`, \`move_file\`, \`analyze_image\` over python scripts.
3. **NO REDUNDANCY**: Check history. Don't repeat successful steps.
4. **FINAL STEP**: The last task MUST be \`submit_response\` to confirm completion to the user.

### Tools Available:
${toolDescriptions}

### Format:
\`\`\`json
{
  "objective": "...",
  "scratchpad": "...",
  "tasks": [
    { "id": 1, "task_type": "simple_action", "action": "...", "description": "...", "parameters": {} }
  ]
}
\`\`\`
`;
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const noThinkMode = config.get<boolean>('noThinkMode') || false;
        return { role: 'system', content: noThinkMode ? `/no_think\n${content}` : content };
    }
}
