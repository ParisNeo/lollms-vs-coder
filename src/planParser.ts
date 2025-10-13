import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { stripThinkingTags } from './utils'; // CORRECTED IMPORT PATH

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
                currentIndex = nextFence + 3 + specifierMatch[0].length;
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

        let content = `${intro}

**CONTEXT & ENVIRONMENT:**
- You are operating inside a VS Code workspace.
- The current working directory for all commands is the project's root folder. Do not create extra subdirectories unless strictly necessary for the project's structure (e.g., a 'src' or 'assets' folder).
- The user has provided a project structure and the content of some files. Use this context to inform your plan. You can request to read other files using the 'read_file' action.
- For Python projects, you should create a virtual environment named 'venv' and use the provided actions to install dependencies and set it as the VS Code interpreter.

**CRITICAL RULES:**
1.  **JSON ONLY:** Your entire response MUST be a single, valid JSON object.
2.  **MARKDOWN BLOCK:** The JSON object MUST be enclosed in a \`\`\`json code block.
3.  **NO EXTRA TEXT:** Do not add any conversational text, apologies, or explanations before or after the JSON block.
4.  **SCRATCHPAD USAGE:** Use the 'scratchpad' to maintain context, store key information (like function names or class definitions you've created), and track your high-level strategy. This helps you remember what you've done in previous steps.
5.  **OS COMPATIBILITY:** All shell commands (\`execute_command\`) MUST be compatible with the OS specified in the user's context (e.g., \`OS: win32\`).

**JSON SCHEMA DEFINITION & ALLOWED ACTIONS:**
Your JSON output must conform to this schema, using only the actions listed below.

\\\`\\\`\\\`json
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
\\\`\\\`\\\`

---

### **ALLOWED ACTIONS & PARAMETERS:**

#### **\`simple_action\`**

*   **\`"action": "execute_command"\`**
    *   \`"parameters": { "command": "string" }\`
*   **\`"action": "rewrite_file"\`**
    *   \`"parameters": { "path": "string", "code": "string" }\` (Use \`{{tasks[ID].result}}\` to reference output from a previous \`generate_code\` or \`read_file\` task)
*   **\`"action": "read_file"\`**
    *   \`"parameters": { "path": "string" }\` (Reads a file's content into the task result for later use, e.g., in a \`generate_code\` prompt)
*   **\`"action": "request_user_input"\`**
    *   \`"parameters": { "question": "string" }\`
*   **\`"action": "set_launch_entrypoint"\`**
    *   \`"parameters": { "file_path": "string" }\`
*   **\`"action": "create_python_environment"\`**
    *   \`"parameters": { "env_name": "venv" }\` (Always use "venv" unless one already exists)
*   **\`"action": "set_vscode_python_interpreter"\`**
    *   \`"parameters": { "env_name": "venv" }\`
*   **\`"action": "install_python_dependencies"\`**
    *   \`"parameters": { "env_name": "venv", "dependencies": ["string"] }\`
*   **\`"action": "execute_python_script"\`**
    *   \`"parameters": { "env_name": "venv", "script_path": "string" }\`

#### **\`agentic_action\`**

*   **\`"action": "generate_code"\`**
    *   \`"parameters": { "file_path": "string", "system_prompt": "string", "user_prompt": "string" }\`
*   **\`"action": "auto_select_context_files"\`**
    *   \`"parameters": { "objective": "string" }\`

---
**ABSOLUTE REQUIREMENTS:**
- Every task object **MUST** contain all keys: "id", "task_type", "action", "description", "parameters".
- The "action" **MUST** be one of the allowed actions.
- The "parameters" for each action **MUST** match the required structure.
- Task IDs **MUST** be unique sequential integers.
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