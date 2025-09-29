import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';

export interface Plan {
    objective: string;
    scratchpad: string;
    tasks: any[];
}

export class PlanParser {
    private maxRetries = 1;

    constructor(
        private lollmsApi: LollmsAPI,
        private contextManager: ContextManager
    ) {}

    public async generateAndParsePlan(
        objective: string,
        existingPlan?: Plan,
        failedTaskId?: number,
        failureReason?: string | null
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
                    lastResponse = await this.lollmsApi.sendChat([systemPrompt, { role: 'user', content: userPromptContent }]);
                } else { // Retry attempt
                     const correctionPrompt = this.getCorrectionPrompt(lastResponse, lastError);
                     lastResponse = await this.lollmsApi.sendChat([correctionPrompt]);
                }
                
                const jsonString = this.extractJson(lastResponse);
                if (!jsonString) {
                    throw new Error("No valid JSON object could be extracted from the response. The response must contain a single JSON object inside a ```json markdown block.");
                }

                const plan = JSON.parse(jsonString) as Plan;
                this.validateAndInitializePlan(plan);

                return { plan, rawResponse: lastResponse };

            } catch (error: any) {
                lastError = error.message;
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
        if (typeof plan.objective !== 'string' || typeof plan.scratchpad !== 'string' || !Array.isArray(plan.tasks)) {
            throw new Error("The plan must have 'objective' (string), 'scratchpad' (string), and 'tasks' (array) properties.");
        }
        if (plan.tasks.length === 0) {
            throw new Error("The plan must contain at least one task.");
        }
        for (const task of plan.tasks) {
            const baseKeys = ['id', 'task_type', 'action', 'description', 'parameters'];
            for (const key of baseKeys) {
                if (task[key] === undefined) {
                    throw new Error(`A task is missing the required property: '${key}'. Full task: ${JSON.stringify(task)}`);
                }
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
        const markdownMatch = text.match(/```json\s*([\s\S]+?)\s*```/);
        if (markdownMatch && markdownMatch[1]) {
            return markdownMatch[1];
        }
    
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            return text.substring(firstBrace, lastBrace + 1);
        }
    
        return null;
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

        return {
            role: 'system',
            content: `${intro}

**CRITICAL RULES:**
1.  **JSON ONLY:** Your entire response MUST be a single, valid JSON object.
2.  **MARKDOWN BLOCK:** The JSON object MUST be enclosed in a \`\`\`json code block.
3.  **NO EXTRA TEXT:** Do not add any conversational text, apologies, or explanations before or after the JSON block. Your response must begin with \`\`\`json and end with \`\`\`.
4.  **OS COMPATIBILITY:** All shell commands and scripts (\`execute_command\`, script file content in \`rewrite_file\`) **MUST** be compatible with the OS specified in the user's context (e.g., \`OS: win32\`).
    -   For **win32**, use PowerShell or CMD/Batch commands.
    -   For **linux** or **darwin**, use Bash/shell commands.
    -   **DO NOT** generate \`bash\` scripts for a \`win32\` environment.

**JSON SCHEMA DEFINITION:**

\`\`\`json
{
  "objective": "string (The user's high-level goal)",
  "scratchpad": "string (Your brief, high-level plan or reasoning)",
  "tasks": [
    {
      "id": "number (A unique, sequential integer for each task, starting from 1)",
      "task_type": "string (Must be either 'simple_action' or 'agentic_action')",
      "action": "string (The specific action to perform. Must be one of the allowed actions listed below)",
      "description": "string (A clear, user-facing description of what this task does)",
      "parameters": "object (A JSON object containing the required parameters for the specified 'action')"
    }
  ]
}
\`\`\`

**ALLOWED ACTIONS & REQUIRED PARAMETERS:**

1.  **task_type: "simple_action"**
    *   \`action: "execute_command"\`
        *   \`parameters: { "command": "string" }\`
    *   \`action: "rewrite_file"\`
        *   \`parameters: { "path": "string", "code": "string" }\` (Use "{{tasks[ID].result}}" to reference output from a previous 'generate_code' task)
    *   \`action: "request_user_input"\`
        *   \`parameters: { "question": "string" }\`
    *   \`action: "set_launch_entrypoint"\`
        *   \`parameters: { "file_path": "string" }\` (Sets the main file for execution in .vscode/launch.json)
    *   \`action: "create_python_environment"\`
        *   \`parameters: { "env_name": "string" }\`
    *   \`action: "set_vscode_python_interpreter"\`
        *   \`parameters: { "env_name": "string" }\`
    *   \`action: "install_python_dependencies"\`
        *   \`parameters: { "env_name": "string", "dependencies": ["string"] }\`
    *   \`action: "execute_python_script"\`
        *   \`parameters: { "env_name": "string", "script_path": "string" }\`

2.  **task_type: "agentic_action"**
    *   \`action: "generate_code"\`
        *   \`parameters: { "file_path": "string", "system_prompt": "string", "user_prompt": "string" }\`
    *   \`action: "auto_select_context_files"\`
        *   \`parameters: { "objective": "string" }\` (Triggers an AI to select relevant files and add them to the context)

**ABSOLUTE REQUIREMENTS:**
- Every task object in the "tasks" array **MUST** contain all keys: "id", "task_type", "action", "description", "parameters".
- The "action" value **MUST** be one of the allowed actions listed above.
- The "parameters" for each action **MUST** match the required structure exactly.
- Task IDs **MUST** be unique sequential integers starting from 1.
- Do not use placeholders or comments within the JSON.
`
        };
    }
}