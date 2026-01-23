import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { stripThinkingTags, getProcessedSystemPrompt } from './utils';
import * as os from 'os';
import { ToolManager } from './tools/toolManager';
import { Plan, ToolDefinition } from './tools/tool';

export class PlanParser {
    private maxRetries = 1;

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
        for (let i = 0; i <= this.maxRetries; i++) {
            try {
                const systemPromptMessage = await this.getPlannerSystemPrompt(!!existingPlan, toolsToUse);
                let messages: ChatMessage[] = [systemPromptMessage];

                if (i === 0) {
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
                        
                        // Grounding instructions for the Architect
                        const groundingBlock = `
# PROJECT WORLD STATE
Current environment and files:
${projectContext.text}

# ARCHITECT PROTOCOL:
1. DO NOT talk to the user in this step. Output ONLY the JSON plan.
2. Every plan MUST end with \`submit_response\`.
3. In \`submit_response\`, do not just repeat raw output. EXTRACT the specific information the user asked for (e.g., if they asked for an IP, find the IP in the previous task's result and present it clearly).
4. Order of operations: Gather data -> Process/Extract -> Submit Response.
`;
                        if (chatHistory.length > 0) messages.push(...chatHistory);

                        messages.push({ role: 'user', content: `${groundingBlock}\n\n**OBJECTIVE:**\n"${objective}"\n\nGenerate the JSON plan.` });
                    }
                    
                    lastResponse = await this.lollmsApi.sendChat(messages, null, signal, modelOverride);
                } else { 
                     const correctionPrompt = { role: 'system' as const, content: `Invalid JSON. Error: ${lastError}. Output ONLY the JSON object. Do not include conversational text.` };
                     lastResponse = await this.lollmsApi.sendChat([...messages, {role: 'assistant', content: lastResponse}, correctionPrompt], null, signal, modelOverride);
                }
                
                // We strip all conversational text from the model's response to ensure only the plan is processed
                const cleanResponse = stripThinkingTags(lastResponse);
                const jsonString = this.extractJson(cleanResponse);

                if (!jsonString) throw new Error("No valid JSON plan found in the response.");

                const plan = JSON.parse(jsonString) as Plan;
                this.validateAndInitializePlan(plan, toolsToUse);

                return { plan, rawResponse: lastResponse };

            } catch (error: any) {
                lastError = error.message;
                if (i >= this.maxRetries) return { plan: null, rawResponse: lastResponse, error: lastError };
            }
        }
        return { plan: null, rawResponse: lastResponse, error: "Failed to generate plan." };
    }

    private validateAndInitializePlan(plan: any, allowedTools: ToolDefinition[]): void {
        if (!plan || typeof plan !== 'object') throw new Error("Plan is not an object.");
        if (!plan.tasks || !Array.isArray(plan.tasks)) throw new Error("Plan missing tasks array.");
    
        const validToolNames = new Set(allowedTools.map(t => t.name));
        for (const task of plan.tasks) {
            if (!validToolNames.has(task.action)) throw new Error(`Tool '${task.action}' is not allowed.`);
            task.status = 'pending';
            task.result = null;
            task.retries = 0;
        }
    }

    public extractJson(text: string): string | null {
        const jsonMatch = text.match(/```json\s*([\s\S]+?)\s*```/) || text.match(/\{[\s\S]*\}/);
        return jsonMatch ? (jsonMatch[1] || jsonMatch[0]).trim() : null;
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
1. **NO CONVERSATION**: Do not say "Sure", "I can help", or "Here is the plan". Output ONLY the JSON object.
2. **USER-FRIENDLY FINISH**: Your last task MUST be \`submit_response\`.
3. **DATA EXTRACTION**: If a previous task produced long output, use \`submit_response\` to EXTRACT and highlight only the relevant answers for the user.
4. **CHRONOLOGY**: Plan steps are executed in order. Do not skip logic.

### Tools Available:
${toolDescriptions}

### Variable Use:
Reference result of task ID 1 like this: \`{{tasks[1].result}}\`.

### Format:
\`\`\`json
{
  "objective": "...",
  "scratchpad": "My reasoning for this specific OS...",
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
