import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { stripThinkingTags } from './utils'; // CORRECTED IMPORT PATH
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
        modelOverride?: string
    ): Promise<{ plan: Plan | null, rawResponse: string, error?: string }> {
        let lastResponse = "";
        let lastError = "";
        for (let i = 0; i <= this.maxRetries; i++) {
            try {
                let userPromptContent: string;
                const systemPrompt = this.getPlannerSystemPrompt(!!existingPlan);

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
                    } else {
                        const projectContext = await this.contextManager.getContextContent();
                        userPromptContent = `My objective is: **${objective}**\n\nHere is the project context:\n${projectContext.text}`;
                    }
                    lastResponse = await this.lollmsApi.sendChat([systemPrompt, { role: 'user', content: userPromptContent }], null, signal, modelOverride);
                } else { // Retry attempt
                     const correctionPrompt = this.getCorrectionPrompt(lastResponse, lastError);
                     lastResponse = await this.lollmsApi.sendChat([correctionPrompt], null, signal, modelOverride);
                }
                
                console.log("--- Lollms Agent Debug: Raw Response from API ---");
                console.log(lastResponse);

                const cleanResponse = stripThinkingTags(lastResponse);
                console.log("--- Lollms Agent Debug: Response after stripping <think> tags ---");
                console.log(cleanResponse);
                
                const jsonString = this.extractJson(cleanResponse);
                console.log("--- Lollms Agent Debug: Extracted JSON string ---");
                console.log(jsonString);


                if (!jsonString) {
                    console.error("--- Lollms Agent Debug: FAILED to extract JSON ---");
                    throw new Error("No valid JSON object could be extracted from the response. The response must contain a single JSON object inside a ```json markdown block.");
                }

                const plan = JSON.parse(jsonString) as Plan;
                console.log("--- Lollms Agent Debug: Parsed Plan Object ---", plan);
                this.validateAndInitializePlan(plan);

                return { plan, rawResponse: lastResponse };

            } catch (error: any) {
                lastError = error.message;
                console.error(`--- Lollms Agent Debug: Attempt ${i + 1} failed ---`, lastError);
                if (i >= this.maxRetries) {
                    return { plan: null, rawResponse: lastResponse, error: `Failed after ${i + 1} attempts. Last error: ${lastError}` };
                }
            }
        }
        return { plan: null, rawResponse: lastResponse, error: "Failed to generate a valid plan after multiple retries." };
    }

    private validateAndInitializePlan(plan: any): void {
        if (!plan || typeof plan !== 'object') {
            throw new Error("The response is not a JSON object.");
        }
        
        // Allow scratchpad to be an object, but ensure it's a string for internal use.
        if (typeof plan.objective !== 'string' || (typeof plan.scratchpad !== 'string' && typeof plan.scratchpad !== 'object') || !Array.isArray(plan.tasks)) {
            throw new Error("The plan must have 'objective' (string), 'scratchpad' (string or object), and 'tasks' (array) properties.");
        }
    
        // If scratchpad is an object, stringify it for consistent handling.
        if (typeof plan.scratchpad === 'object' && plan.scratchpad !== null) {
            plan.scratchpad = JSON.stringify(plan.scratchpad, null, 2);
        }
    
        if (plan.tasks.length === 0 && !plan.objective.startsWith("Thank you")) { // Allow empty tasks for thank you messages
            throw new Error("The plan must contain at least one task.");
        }
    
        const allowedTools = new Set(this.toolManager.getAllTools().map((t: ToolDefinition) => t.name));
    
        for (const task of plan.tasks) {
            const baseKeys = ['id', 'task_type', 'action', 'description', 'parameters'];
            for (const key of baseKeys) {
                if (task[key] === undefined) {
                    throw new Error(`A task is missing the required property: '${key}'. Full task: ${JSON.stringify(task)}`);
                }
            }
    
            if (!allowedTools.has(task.action)) {
                throw new Error(`Invalid action '${task.action}'. Action must be one of the allowed tools.`);
            }
    
            if (typeof task.parameters !== 'object' || task.parameters === null) {
                 throw new Error(`The 'parameters' property for task ${task.id} must be a JSON object.`);
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
            // Fallback for non-markdown or non-specified JSON
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
                const potentialJson = text.substring(firstBrace, lastBrace + 1);
                try {
                    JSON.parse(potentialJson); // Validate it's actual JSON
                    return potentialJson;
                } catch (e) {
                    return null;
                }
            }
            return null;
        }
    
        const jsonStart = contentStartIndex + blockStartTag.length;
        let depth = 1;
        let currentIndex = jsonStart;
    
        while (depth > 0 && currentIndex < text.length) {
            const nextFence = text.indexOf('```', currentIndex);
    
            if (nextFence === -1) {
                return null; // No more fences found, block is unclosed
            }
    
            // Check for a language specifier immediately after the fence
            const specifierMatch = text.substring(nextFence + 3).match(/^\s*([a-zA-Z0-9]+)/);
    
            if (specifierMatch) {
                // This is an opening fence for a nested block
                depth++;
                currentIndex = nextFence + 3 + specifierMatch.length;
            } else {
                // This is a closing fence
                depth--;
                if (depth === 0) {
                    // We found the matching closing fence
                    return text.substring(jsonStart, nextFence).trim();
                }
                currentIndex = nextFence + 3;
            }
        }
        return null; // Loop completed without finding a balanced closing fence
    }

    private getCorrectionPrompt(faultyResponse: string, errorMessage: string): ChatMessage {
        return {
            role: 'system',
            content: `You previously provided the following text which failed validation.
--- FAULTY RESPONSE ---
${faultyResponse}
--- ERROR MESSAGE ---
${errorMessage}
---
Your task is to correct the JSON. You MUST provide ONLY the fixed, valid JSON object that adheres to the required schema, inside a markdown code block. Ensure every task has all required keys: 'id', 'task_type', 'action', 'description', 'parameters', and that the parameters for each action are correct.`
        };
    }

    public getPlannerSystemPrompt(isRevision: boolean = false): ChatMessage {
        const intro = isRevision
            ? "You are an expert AI agent planner specializing in failure recovery. Your task is to create a new plan fragment to achieve the original objective, starting from the point of failure."
            : "You are a meticulous, programmatic AI agent planner. Your sole function is to create a detailed, step-by-step execution plan in JSON format based on a user's objective and project context.";

        const tools = this.toolManager.getEnabledTools();
        const toolDescriptions = tools.map((tool: ToolDefinition) => {
            const params = tool.parameters.map((p: { name: string; type: string; description: string; required: boolean; }) => `{"name": "${p.name}", "type": "${p.type}", "description": "${p.description}", "required": ${p.required}}`).join(',\n');
            return `* **"${tool.name}"**: ${tool.description}\n  - Parameters: \`[${params}]\`\n  - Type: \`${tool.isAgentic ? 'agentic_action' : 'simple_action'}\``;
        }).join('\n');

        let content = `${intro}

**<MASTER_RULE>**
YOUR ENTIRE RESPONSE MUST BE A SINGLE, VALID JSON OBJECT, AND IT MUST BE ENCLOSED IN A \`\`\`json MARKDOWN BLOCK. ANY TEXT, EXPLANATION, OR APOLOGY OUTSIDE THIS BLOCK WILL CAUSE A SYSTEM FAILURE. ADHERE TO THIS FORMAT WITH ABSOLUTE PRECISION.
**</MASTER_RULE>**

**CONTEXT & ENVIRONMENT:**
- You are operating inside a VS Code workspace at the project root. All file paths MUST be relative.
- The user's operating system is: \`${os.platform()}\`. All shell commands must be OS-compatible.
- For Python projects, it is mandatory to first create and use a virtual environment (e.g., \`create_python_environment\`) to ensure isolation.
- It is a best practice to start by using \`get_environment_details\` to understand available tools.

**<CRITICAL_INSTRUCTIONS>**
1.  **JSON ONLY:** Your entire response MUST be a single, valid JSON object inside a \`\`\`json block.
2.  **NO EXTRA TEXT:** Do not add any conversational text or explanations before or after the JSON block.
3.  **SCRATCHPAD IS A STRING:** The 'scratchpad' field MUST be a single string for your internal notes. Do not use a JSON object for it.
4.  **DECOMPOSE TASKS:** Break complex goals into a sequence of smaller, logical, and verifiable steps. This is crucial. For example, instead of 'build the app', create tasks for 'list files', 'setup environment', 'create file', 'write component A', 'write component B', etc.
5.  **SAFETY:** Avoid destructive commands. Use \`request_user_input\` for any potentially risky operation.
6.  **AUTONOMY:** You have tools to read and write files (\`read_file\`, \`generate_code\`). **NEVER** ask the user to provide file content or paste code (e.g., "ask user to paste file"). Use \`read_file\` to get the content yourself. If you are unsure of the file path, use \`list_files\` first. Only ask the user for clarification on requirements/intent.
**</CRITICAL_INSTRUCTIONS>**

**JSON SCHEMA DEFINITION & ALLOWED ACTIONS:**
Your JSON output must conform to this schema, using only the actions listed below.

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
      "parameters": {
        // action-specific parameters go here
      }
    }
  ]
}
\`\`\`

---

### **ALLOWED ACTIONS & PARAMETERS:**
${toolDescriptions}

---
**<FINAL_REMINDER>**
- Every task object **MUST** contain all keys: "id", "task_type", "action", "description", "parameters".
- The "action" **MUST** be one of the allowed actions.
- The "parameters" for each action **MUST** match the required structure.
- Task IDs **MUST** be unique sequential integers.
**</FINAL_REMINDER>**
`;
        
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const noThinkMode = config.get<boolean>('noThinkMode') || false;
        if (noThinkMode) {
            content = `/no_think\n${content}`;
        }

        return {
            role: 'system',
            content: content
        };
    }
}
