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
    ): Promise<{ plan: Plan | null, rawResponse: string }> {
        let lastResponse = "";
        for (let i = 0; i <= this.maxRetries; i++) {
            try {
                let userPromptContent: string;
                const systemPrompt = this.getPlannerSystemPrompt(!!existingPlan);

                if (i === 0) {
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
                }
                
                const jsonString = this.extractJson(lastResponse);
                if (!jsonString) {
                    throw new Error("No valid JSON object could be extracted from the response.");
                }

                const plan = JSON.parse(jsonString) as Plan;
                this.validateAndInitializePlan(plan);

                return { plan, rawResponse: lastResponse };

            } catch (error: any) {
                if (i < this.maxRetries) {
                    const correctionPrompt = this.getCorrectionPrompt(lastResponse, error.message);
                    lastResponse = await this.lollmsApi.sendChat([correctionPrompt]);
                } else {
                    return { plan: null, rawResponse: lastResponse || `Failed after retries. Last error: ${error.message}` };
                }
            }
        }
        return { plan: null, rawResponse: "Failed to generate a valid plan after multiple retries." };
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
        const markdownMatch = text.match(/```json\n([\s\S]*?)\n```/);
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
Your task is to correct the JSON. You MUST provide ONLY the fixed, valid JSON object that adheres to the required schema. Ensure every task has all required keys: 'id', 'task_type', 'action', 'description', 'parameters', and that the parameters for each action are correct.`
        };
    }

    public getPlannerSystemPrompt(isRevision: boolean = false): ChatMessage {
        const intro = isRevision
            ? "You are an expert AI agent planner specializing in failure recovery. Create a new plan fragment to achieve the original objective, starting from the point of failure."
            : "You are a planning-focused AI agent. Your sole function is to create a detailed, step-by-step execution plan in JSON format.";

        return {
            role: 'system',
            content: `${intro}

**CRITICAL: YOUR RESPONSE MUST BE A SINGLE, VALID JSON OBJECT, WRAPPED IN A \`\`\`json CODE BLOCK. FOLLOW THE SCHEMA EXACTLY.**

**FULL EXAMPLE OF A CORRECT RESPONSE:**
\`\`\`json
{
  "objective": "Create a pygame snake game.",
  "scratchpad": "The user wants a snake game. I will create a virtual environment, set it in VS Code, install pygame, generate the python code, save it to a file, and finally create a task to run it.",
  "tasks": [
    {
      "id": 1,
      "task_type": "simple_action",
      "action": "create_python_environment",
      "description": "Create a Python virtual environment named 'venv_snake'.",
      "parameters": { 
        "env_name": "venv_snake"
      }
    },
    {
      "id": 2,
      "task_type": "simple_action",
      "action": "set_vscode_python_interpreter",
      "description": "Set the VS Code interpreter to the new venv.",
      "parameters": { 
        "env_name": "venv_snake" 
      }
    },
    {
      "id": 3,
      "task_type": "simple_action",
      "action": "install_python_dependencies",
      "description": "Install the 'pygame' library.",
      "parameters": { 
        "env_name": "venv_snake", 
        "dependencies": ["pygame"] 
      }
    },
    {
      "id": 4,
      "task_type": "agentic_action",
      "action": "generate_code",
      "description": "Generate the Python code for the snake game.",
      "parameters": {
        "file_path": "snake_game.py",
        "system_prompt": "You are a Python game developer. Write a complete, runnable snake game using pygame.",
        "user_prompt": "Create a simple snake game. The game should have a snake, food, scoring, and a game-over condition."
      }
    },
    {
      "id": 5,
      "task_type": "simple_action",
      "action": "rewrite_file",
      "description": "Save the generated code to 'snake_game.py'.",
      "parameters": {
        "path": "snake_game.py",
        "code": "{{tasks[4].result}}"
      }
    },
    {
      "id": 6,
      "task_type": "simple_action",
      "action": "execute_python_script",
      "description": "Run the snake game to test it.",
      "parameters": {
        "env_name": "venv_snake",
        "script_path": "snake_game.py"
      }
    }
  ]
}
\`\`\`
`
        };
    }
}