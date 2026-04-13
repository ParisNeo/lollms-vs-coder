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
# 🕒 PROJECT TIMELINE (DEBUGGING LOG)
The following actions were recently taken. Compare the "Intended Goal" with the "Actual Observation".

${completedActionsHistory.join('\n\n')}

**CRITICAL DIAGNOSTIC**:
- If an action resulted in SUCCESS but the observation shows the screen didn't change as expected (e.g., you clicked but no menu appeared), the previous coordinates were WRONG.
- You MUST adjust your strategy (e.g., different tool, different location, or more discovery) in the next plan.
- DO NOT repeat failed steps with the same parameters.
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
        // --- 🛡️ CRITICAL SCRUBBER ---
        // Strip illegal control characters (0-31) that often sneak into 
        // string literals from terminal output and break JSON.parse()
        let cleaned = text.replace(/[\x00-\x1F\x7F]/g, (match) => {
            if (match === '\n') return '\n';
            if (match === '\r') return '\r';
            if (match === '\t') return '\t';
            return ''; // Remove all others
        }).trim();
        
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
        // This is a "hail mary" for truncated server responses
        if (!result && startIndex !== -1 && braceCount > 0) {
            // If it ends mid-string, try to close the string first
            let attempt = cleaned.substring(startIndex);
            if (attempt.split('"').length % 2 === 0) { 
                attempt += '"'; 
            }
            attempt += "}".repeat(braceCount);
            
            try {
                JSON.parse(attempt);
                result = attempt;
            } catch (e) {}
        }

        return result;
    }

    public async getArchitectSystemPrompt(allowedTools: ToolDefinition[], importedSkillIds?: string[]): Promise<ChatMessage> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const agentPersona = config.get<string>('agentPersona') || "You are an autonomous AI Agent.";
        
        // We pass 'agent' type to get formatting rules for AIDER and Code Generation
        const baseSystemInfo = await getProcessedSystemPrompt('agent', undefined, agentPersona);

        const toolDescriptions = allowedTools.map(tool => {
            const params = tool.parameters.map(p => `"${p.name}" (${p.type}): ${p.description}`).join(', ');
            return `- **${tool.name}**: ${tool.description} (Params: ${params})`;
        }).join('\n');

        const skillsDesc = (importedSkillIds && importedSkillIds.length > 0) 
            ? importedSkillIds.map(id => `- ${id}`).join('\n')
            : "- No specific skills imported.";

        const content = `${baseSystemInfo}

# 🧞 THE GENIE PROTOCOL (RE-ACT)
You are an **Autonomous Operator**. You do not just "plan"; you **execute and observe**. 
You operate in a high-frequency loop: **Reason -> Act -> Observe**.

### 🔄 THE LOOP RULES (RE-ACT PROTOCOL)
1. **ONE STEP AT A TIME**: Output exactly ONE tool call per response. 
2. **THE ERROR MANDATE**: If you see a Python error (e.g., \`NameError\`, \`ImportError\`), you have ONE turn to \`read_file\`. In the VERY NEXT turn, you MUST apply a fix using \`generate_code\`. No "thinking" loops allowed.
3. **FIXING NameError**: If you see \`name 'nn' is not defined\`, it means an import like \`import torch.nn as nn\` is missing. Locate the top of the file and add it immediately.
4. **DEBUGGING BIAS**: Use \`generate_code\` to insert \`print(f"DEBUG: {var}")\` to verify your assumptions.
5. **NO REPETITION**: If a tool call resulted in "REPETITIVE ACTION" or "LOOP BLOCKED", you are FORBIDDEN from using that tool again on the same path. Switch to 'generate_code' immediately.
5. **DISCOVERY FIRST**: You cannot fix what you cannot see. Use \`read_file\` to understand the current logic and imports before proposing a change.
6. **LONG-RUNNING TASKS**: If you start a training or a long test, do NOT just sit and wait.
   - Use \`read_output_tail\` every few turns to check progress.
   - If metrics (loss, accuracy) look bad, use \`stop_process\` to kill the run and adjust hyperparameters.
   - Use \`wait\` (e.g. 30 seconds) between checks to be patient.
7. **FINISH**: Only use \`submit_response\` when you have verified the fix works by running the code again.

### 🛠️ TOOLS AT YOUR DISPOSAL
${toolDescriptions}

### 💡 SKILLS & CONTEXT
${skillsDesc}

### 🛑 RESPONSE FORMAT (STRICT)
You MUST output ONLY a valid JSON object.
- **THOUGHT RULES**: Provide ONLY the logic for the CURRENT step (max 2 sentences). 
- **NO REDUNDANCY**: Do NOT repeat the mission objective. Do NOT summarize previous tasks (I can see them in the timeline).
- **CONCISENESS**: Focus on the *next* operation and why you chose those specific parameters.

\`\`\`json
{
  "thought": "I found a syntax error on line 42; I will use generate_code with a SEARCH/REPLACE block to fix the indentation.",
  "tool": "tool_name",
  "params": {
    "key": "value"
  }
}
\`\`\`
`;
        return { role: 'system', content };
    }

    public async getPlannerSystemPrompt(isRevision: boolean = false, allowedTools: ToolDefinition[], importedSkills?: string[]): Promise<ChatMessage> {
        return this.getArchitectSystemPrompt(allowedTools, importedSkills);
    }
}
