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
5. **PROTOCOL**: 
   - Execute tool.
   - Observe output.
   - If output contains the answer, create a NEW task to \`submit_response\` with the HARDCODED answer.
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
                    console.log(`PlanParser: Retry attempt ${i}. Last error: ${lastError}`);
                    
                    const correctionPrompt = { 
                        role: 'system' as const, 
                        content: `❌ **CRITICAL ERROR: INVALID JSON FORMAT**
Your previous response was not a valid plan. You probably tried to answer the user directly or output shell commands without the JSON wrapper.

**MANDATORY CORRECTION:**
1. You MUST use the \`submit_response\` tool to give the answer.
2. You MUST NOT output raw text like "To set a variable, use..." or "setx MYVAR...".
3. Your response must be valid JSON ONLY.
4. Start your response with \`{\` and end with \`}\`.

**EXAMPLE OF CORRECT OUTPUT FOR YOUR TASK:**
{
  "objective": "${objective.substring(0, 50)}...",
  "scratchpad": "I will provide the requested information using the submit_response tool.",
  "tasks": [
    { "id": 1, "task_type": "simple_action", "action": "submit_response", "description": "Provide the requested instructions", "parameters": {"response": "The detailed instructions go here..."} }
  ]
}` 
                    };
                    
                    messages.push({ role: 'assistant', content: lastResponse });
                    messages.push(correctionPrompt);
                }

                lastResponse = await this.lollmsApi.sendChat(messages, null, signal, modelOverride);
                
                const cleanResponse = stripThinkingTags(lastResponse);
                const jsonString = this.extractJson(cleanResponse);

                if (!jsonString) throw new Error("Could not find a valid JSON object containing the 'tasks' key. Ensure you are not providing conversational text.");

                let plan: Plan;
                try {
                    plan = JSON.parse(jsonString) as Plan;
                } catch (e: any) {
                    throw new Error(`JSON Parse Error: ${e.message}`);
                }

                this.validateAndInitializePlan(plan, toolsToUse);

                return { plan, rawResponse: lastResponse };

            } catch (error: any) {
                lastError = error.message;
                if (i >= this.maxRetries) {
                    return { plan: null, rawResponse: lastResponse, error: `Failed after ${this.maxRetries} retries. ${lastError}` };
                }
            }
        }
        return { plan: null, rawResponse: lastResponse, error: "Failed to generate plan." };
    }

    private formatHistoryForContext(history: ChatMessage[]): string {
        if (!history || history.length === 0) return "";
        
        let text = "## PREVIOUS CONVERSATION HISTORY\n(For Context Only - Do not repeat previous actions unless requested)\n\n";
        
        for (const msg of history) {
            if (msg.role === 'system') continue; 
            
            let contentStr = "";
            if (Array.isArray(msg.content)) {
                contentStr = msg.content.map(c => c.type === 'text' ? c.text : '[Image]').join('\n');
            } else {
                contentStr = String(msg.content);
            }
            
            if (contentStr.length > 3000) {
                contentStr = contentStr.substring(0, 3000) + "\n... [truncated] ...";
            }
            
            text += `**${msg.role.toUpperCase()}**: ${contentStr}\n\n`;
        }
        
        return text + "---\n\n";
    }

    private validateAndInitializePlan(plan: any, allowedTools: ToolDefinition[]): void {
        if (!plan || typeof plan !== 'object') throw new Error("Plan is not an object.");
        
        if (!plan.tasks) {
            if (plan.steps && Array.isArray(plan.steps)) plan.tasks = plan.steps;
            else if (plan.plan && Array.isArray(plan.plan)) plan.tasks = plan.plan;
            else if (plan.actions && Array.isArray(plan.actions)) plan.tasks = plan.actions;
        }
        
        if (!plan.tasks || !Array.isArray(plan.tasks)) throw new Error("Plan missing 'tasks' array.");
    
        const validToolNames = new Set(allowedTools.map(t => t.name));
        for (const task of plan.tasks) {
            if (!task.action) throw new Error("Task missing 'action' field.");
            if (!validToolNames.has(task.action)) throw new Error(`Tool '${task.action}' is not allowed or does not exist.`);
            task.status = 'pending';
            task.result = null;
            task.retries = 0;
        }
    }

    public extractJson(text: string): string | null {
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            const candidate = text.substring(firstBrace, lastBrace + 1);
            if (candidate.includes('"tasks"') || candidate.includes('"steps"')) {
                return candidate;
            }
        }

        const markdownMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
        if (markdownMatch) {
            return markdownMatch[1].trim();
        }

        return null;
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
2. **NO CONVERSATION**: Do NOT explain your plan. Do NOT chat. 
3. **NO RAW OUTPUT**: Do NOT output shell commands or code snippets as raw text. Everything must be inside a tool call.
4. **MANDATORY START**: Your response MUST start with the character \`{\`.
5. **SKILL USE**: If there is a **Skill** in the context (like Moltbook), you MUST refer to its documentation for the correct API endpoints, auth headers, and logic.

### PROHIBITED BEHAVIOR:
- **Do not** start with "Certainly!" or "Here is the plan".
- **Do not** provide the answer directly in markdown.
- **Do not** output a bash/powershell script block unless it is a parameter of a tool.

### EXAMPLE: Skill-based Implementation
**User:** "Add login feature to my moltbook script"
**Output:**
{
  "objective": "Update moltbook script with login logic",
  "scratchpad": "I will read the moltbook skill documentation to find the correct registration endpoint, then update the script.",
  "tasks": [
    { "id": 1, "task_type": "simple_action", "action": "read_file", "description": "Read current script", "parameters": {"path": "moltbook_interact.py"} },
    { "id": 2, "task_type": "simple_action", "action": "generate_code", "description": "Implement login logic based on Moltbook Skill", "parameters": {"file_path": "moltbook_interact.py", "user_prompt": "Add the /agents/register endpoint logic as defined in the Moltbook skill documentation."} },
    { "id": 3, "task_type": "simple_action", "action": "submit_response", "description": "Notify user", "parameters": {"response": "Login logic has been added to moltbook_interact.py."} }
  ]
}

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
