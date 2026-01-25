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
        allowedTools?: ToolDefinition[]
    ): Promise<{ plan: Plan | null, rawResponse: string, error?: string }> {
        
        const toolsToUse = allowedTools || this.toolManager.getEnabledTools();

        let lastResponse = "";
        let lastError = "";
        
        // Prepare initial messages outside the loop to preserve the base request
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
                const projectContext = await this.contextManager.getContextContent({ includeTree: true });
                
                const groundingBlock = `
# PROJECT WORLD STATE
Current environment and files:
${projectContext.text}

# ARCHITECT PROTOCOL:
1. Output ONLY the JSON plan.
2. Every plan MUST end with \`submit_response\`.
3. **DO NOT USE TEMPLATES**: Do NOT use syntax like \`{{ ... | regex_search ... }}\`. You CANNOT perform parsing in the final response.
4. **PROTOCOL**: 
   - Execute tool.
   - Observe output.
   - If output contains the answer, create a NEW task to \`submit_response\` with the HARDCODED answer.
`;
                // Convert chat history to passive context to preventing role confusion
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
                if (i > 0) {
                    // This is a retry
                    console.log(`PlanParser: Retry attempt ${i}. Last error: ${lastError}`);
                    
                    const correctionPrompt = { 
                        role: 'system' as const, 
                        content: `❌ **JSON PARSING FAILED**
The previous response was not valid JSON or did not match the schema.
**Error Details:** ${lastError}

**INSTRUCTIONS FOR RETRY:**
1. Fix the JSON syntax errors.
2. Ensure you are returning a SINGLE valid JSON object containing a "tasks" array.
3. Do not include any text before or after the JSON (no markdown fences if possible, or strictly \`\`\`json ... \`\`\`).
4. Output the corrected JSON now.` 
                    };
                    
                    // Add the previous response and the correction prompt to the history
                    messages.push({ role: 'assistant', content: lastResponse });
                    messages.push(correctionPrompt);
                }

                lastResponse = await this.lollmsApi.sendChat(messages, null, signal, modelOverride);
                
                // CRITICAL: Strip thinking tags first to avoid parsing "crud" JSON from thought process
                const cleanResponse = stripThinkingTags(lastResponse);
                const jsonString = this.extractJson(cleanResponse);

                if (!jsonString) throw new Error("No valid JSON structure found in response (expected { ... }).");

                let plan: Plan;
                try {
                    plan = JSON.parse(jsonString) as Plan;
                } catch (e: any) {
                    throw new Error(`JSON Parse Error: ${e.message}. Content was: ${jsonString.substring(0, 100)}...`);
                }

                this.validateAndInitializePlan(plan, toolsToUse);

                return { plan, rawResponse: lastResponse };

            } catch (error: any) {
                lastError = error.message;
                // If this was the last retry, return failure
                if (i >= this.maxRetries) {
                    return { plan: null, rawResponse: lastResponse, error: `Failed after ${this.maxRetries} retries. Last error: ${lastError}` };
                }
            }
        }
        return { plan: null, rawResponse: lastResponse, error: "Failed to generate plan." };
    }

    private formatHistoryForContext(history: ChatMessage[]): string {
        if (!history || history.length === 0) return "";
        
        let text = "## PREVIOUS CONVERSATION HISTORY\n(For Context Only - Do not repeat previous actions unless requested)\n\n";
        
        for (const msg of history) {
            // Skip system messages to prevent persona injection from history
            if (msg.role === 'system') continue; 
            
            let contentStr = "";
            if (Array.isArray(msg.content)) {
                contentStr = msg.content.map(c => c.type === 'text' ? c.text : '[Image]').join('\n');
            } else {
                contentStr = String(msg.content);
            }
            
            // Truncate very long messages (e.g. large file reads) to save tokens and focus
            if (contentStr.length > 3000) {
                contentStr = contentStr.substring(0, 3000) + "\n... [truncated] ...";
            }
            
            text += `**${msg.role.toUpperCase()}**: ${contentStr}\n\n`;
        }
        
        return text + "---\n\n";
    }

    private validateAndInitializePlan(plan: any, allowedTools: ToolDefinition[]): void {
        if (!plan || typeof plan !== 'object') throw new Error("Plan is not an object.");
        
        // Support common hallucinations for the task list key
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
        // Try to match standard markdown json block
        const markdownMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
        if (markdownMatch) {
            return markdownMatch[1].trim();
        }
        
        // Try to match raw JSON object
        const objectMatch = text.match(/\{[\s\S]*\}/);
        if (objectMatch) {
            return objectMatch[0].trim();
        }

        // Try to match raw JSON array (sometimes models output array of tasks directly)
        // If so, we wrap it in the expected plan structure
        const arrayMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (arrayMatch) {
            return JSON.stringify({
                objective: "Inferred Objective from Task List",
                scratchpad: "Plan generated as raw task list.",
                tasks: JSON.parse(arrayMatch[0])
            });
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
1. **NO CONVERSATION**: Output ONLY the JSON object.
2. **DATA EXTRACTION RULES**: 
   - **NEVER** use \`{{ ... | regex_search ... }}\` or Jinja templates.
   - **NEVER** assume you can parse output in the \`submit_response\`.
   - You MUST instruct the agent to run a command, and then the Supervisor will observe the output.
3. **CHRONOLOGY**: Plan steps are executed in order.

### Tools Available:
${toolDescriptions}

### Variable Use:
Reference result of task ID 1 like this: \`{{tasks[1].result}}\`. 
**WARNING**: This only pastes the RAW string output. It does NOT extract data.

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
