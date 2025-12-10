import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { stripThinkingTags } from './utils';
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
        allowedTools?: ToolDefinition[] // NEW parameter
    ): Promise<{ plan: Plan | null, rawResponse: string, error?: string }> {
        
        // Default to all enabled tools if not specified
        const toolsToUse = allowedTools || this.toolManager.getEnabledTools();

        let lastResponse = "";
        let lastError = "";
        for (let i = 0; i <= this.maxRetries; i++) {
            try {
                let userPromptContent: string;
                // Pass toolsToUse to system prompt generator
                const systemPrompt = this.getPlannerSystemPrompt(!!existingPlan, toolsToUse);
                let messages: ChatMessage[] = [systemPrompt];

                if (i === 0) { // First attempt
                    if (existingPlan && failedTaskId !== undefined && failureReason) {
                        userPromptContent = `The original objective was: "${objective}".
We were executing a plan, but task ${failedTaskId} failed with the following result:
---
${failureReason}
---
Here is the plan up to the point of failure:
\`\`\`json
${JSON.stringify({ ...existingPlan, tasks: existingPlan.tasks.filter(t => t.id <= failedTaskId) }, null, 2)}
\`\`\`
Your task is to generate a NEW set of tasks to recover from this failure and complete the objective. The new plan fragment will replace the failed task and all subsequent tasks.`;
                        messages.push({ role: 'user', content: userPromptContent });
                    } else {
                        const projectContext = await this.contextManager.getContextContent();
                        
                        if (chatHistory && chatHistory.length > 0) {
                            messages.push(...chatHistory);
                        }

                        userPromptContent = `My objective is: **${objective}**\n\nHere is the project context:\n${projectContext.text}`;
                        messages.push({ role: 'user', content: userPromptContent });
                    }
                    
                    lastResponse = await this.lollmsApi.sendChat(messages, null, signal, modelOverride);
                } else { // Retry attempt
                     const correctionPrompt = this.getCorrectionPrompt(lastResponse, lastError);
                     lastResponse = await this.lollmsApi.sendChat([correctionPrompt], null, signal, modelOverride);
                }
                
                const cleanResponse = stripThinkingTags(lastResponse);
                const jsonString = this.extractJson(cleanResponse);

                if (!jsonString) {
                    throw new Error("No valid JSON object could be extracted from the response.");
                }

                const plan = JSON.parse(jsonString) as Plan;
                this.validateAndInitializePlan(plan, toolsToUse);

                return { plan, rawResponse: lastResponse };

            } catch (error: any) {
                lastError = error.message;
                if (i >= this.maxRetries) {
                    return { plan: null, rawResponse: lastResponse, error: `Failed after ${i + 1} attempts. Last error: ${lastError}` };
                }
            }
        }
        return { plan: null, rawResponse: lastResponse, error: "Failed to generate a valid plan." };
    }

    private validateAndInitializePlan(plan: any, allowedTools: ToolDefinition[]): void {
        if (!plan || typeof plan !== 'object') throw new Error("Response is not a JSON object.");
        
        if (typeof plan.objective !== 'string' || (typeof plan.scratchpad !== 'string' && typeof plan.scratchpad !== 'object') || !Array.isArray(plan.tasks)) {
            throw new Error("Plan missing required fields (objective, scratchpad, tasks).");
        }
    
        if (typeof plan.scratchpad === 'object' && plan.scratchpad !== null) {
            plan.scratchpad = JSON.stringify(plan.scratchpad, null, 2);
        }
    
        const validToolNames = new Set(allowedTools.map(t => t.name));
    
        for (const task of plan.tasks) {
            if (!task.action || !task.description) {
                throw new Error(`Task missing action or description.`);
            }
    
            if (!validToolNames.has(task.action)) {
                throw new Error(`Invalid action '${task.action}'. Must be one of: ${Array.from(validToolNames).join(', ')}`);
            }
            
            task.status = 'pending';
            task.result = null;
            task.retries = 0;
        }
    }

    public extractJson(text: string): string | null {
        const blockStartTag = '```json';
        const contentStartIndex = text.indexOf(blockStartTag);
        if (contentStartIndex === -1) {
            // Try finding just a brace
            const first = text.indexOf('{');
            const last = text.lastIndexOf('}');
            if (first !== -1 && last > first) return text.substring(first, last + 1);
            return null;
        }
        const jsonStart = contentStartIndex + blockStartTag.length;
        const jsonEnd = text.indexOf('```', jsonStart);
        if (jsonEnd === -1) return null;
        return text.substring(jsonStart, jsonEnd).trim();
    }

    private getCorrectionPrompt(faultyResponse: string, errorMessage: string): ChatMessage {
        return {
            role: 'system',
            content: `Your previous JSON response was invalid.\nError: ${errorMessage}\nPlease fix the JSON and return ONLY the valid JSON object in a markdown block.`
        };
    }

    public getPlannerSystemPrompt(isRevision: boolean = false, allowedTools: ToolDefinition[]): ChatMessage {
        const intro = isRevision
            ? "You are an expert AI agent planner specializing in failure recovery."
            : "You are a meticulous, programmatic AI agent planner.";

        const toolDescriptions = allowedTools.map((tool: ToolDefinition) => {
            const params = tool.parameters.map((p: { name: string; type: string; description: string; required: boolean; }) => `{"name": "${p.name}", "type": "${p.type}", "description": "${p.description}", "required": ${p.required}}`).join(', ');
            return `* **"${tool.name}"**: ${tool.description}\n  - Params: \`[${params}]\``;
        }).join('\n');

        let groundingInstruction = "";
        const hasSearch = allowedTools.some(t => t.name === 'search_web');
        if (hasSearch) {
            groundingInstruction = `7. **GROUNDING:** You have access to \`search_web\`. If you encounter an unknown error or need documentation, create a task to SEARCH for it. Do not guess.`;
        } else {
            groundingInstruction = `7. **GROUNDING:** You do NOT have internet access. Rely on the provided context files and your internal knowledge.`;
        }

        const content = `${intro}

**CONTEXT:**
- Operating System: \`${os.platform()}\`.
- Workspace Root: Project root directory.

**<CRITICAL_INSTRUCTIONS>**
1.  **JSON ONLY:** Return a single valid JSON object in a \`\`\`json block.
2.  **NO EXTRA TEXT:** No conversation.
3.  **DECOMPOSE TASKS:** Break goals into logical steps.
4.  **AUTONOMY:** Use \`read_file\` to get content. Do not ask user for files.
5.  **SAFETY:** Use \`request_user_input\` for dangerous operations.
6.  **PYTHON:** Create/use venv for python tasks.
${groundingInstruction}
**</CRITICAL_INSTRUCTIONS>**

**JSON SCHEMA:**
\`\`\`json
{
  "objective": "string",
  "scratchpad": "string",
  "tasks": [
    {
      "id": "number",
      "task_type": "'simple_action' or 'agentic_action'",
      "action": "string",
      "description": "string",
      "parameters": { ... }
    }
  ]
}
\`\`\`

**AVAILABLE TOOLS:**
${toolDescriptions}
`;
        
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const noThinkMode = config.get<boolean>('noThinkMode') || false;
        return {
            role: 'system',
            content: noThinkMode ? `/no_think\n${content}` : content
        };
    }
}
