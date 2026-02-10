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
        importedSkills?: string[],
        completedActionsHistory?: string[] 
    ): Promise<{ plan: Plan | null, rawResponse: string, error?: string }> {
        
        const toolsToUse = allowedTools || this.toolManager.getEnabledTools();
        let lastResponse = "";
        let lastError = "";
        
        let messages: ChatMessage[] = [];
        try {
            const systemPromptMessage = await this.getPlannerSystemPrompt(!!existingPlan, toolsToUse);
            messages.push(systemPromptMessage);

            // Construct the memory block
            let memoryBlock = "";
            if (completedActionsHistory && completedActionsHistory.length > 0) {
                memoryBlock = `
# 🧠 COMPLETED ACTIONS MEMORY
The following actions have ALREADY been successfully executed in this session.
**DO NOT** include these in the new plan unless you explicitly intend to redo them (e.g. rewrite a file).
${completedActionsHistory.map(a => `- [DONE] ${a}`).join('\n')}
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
3. **CRITICAL**: Do NOT include steps listed in "COMPLETED ACTIONS" above. Start the plan from the next logical step.
`;
                messages.push({ role: 'user', content: failureContext });
            } else {
                const projectContext = await this.contextManager.getContextContent({ 
                    includeTree: true,
                    importedSkillIds: importedSkills
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
        }
    }

    public extractJson(text: string): string | null {
        // 1. Try Markdown Code Block
        const markdownMatch = text.match(/```json\s*([\s\S]+?)\s*```/);
        if (markdownMatch) {
            const potentialJson = markdownMatch[1].trim();
            // Validate if it looks like a plan (has "tasks" or "objective")
            if (potentialJson.includes('"tasks"') || potentialJson.includes('"steps"')) {
                return potentialJson;
            }
        }

        // 2. Scan for balanced braces to find embedded JSON objects
        const jsonObjects: string[] = [];
        let braceCount = 0;
        let startIndex = -1;
        
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '{') {
                if (braceCount === 0) startIndex = i;
                braceCount++;
            } else if (text[i] === '}') {
                braceCount--;
                if (braceCount === 0 && startIndex !== -1) {
                    jsonObjects.push(text.substring(startIndex, i + 1));
                    startIndex = -1;
                }
            }
        }

        // 3. Find the object that looks like a Plan
        const planJson = jsonObjects.find(j => j.includes('"tasks"') || j.includes('"steps"'));
        return planJson || null;
    }

    public async getArchitectSystemPrompt(allowedTools: ToolDefinition[]): Promise<ChatMessage> {
        const baseSystemInfo = await getProcessedSystemPrompt('agent');
        const toolDescriptions = allowedTools.map(tool => {
            const params = tool.parameters.map(p => `"${p.name}" (${p.type}): ${p.description}`).join(', ');
            return `- **${tool.name}**: ${tool.description} (Params: ${params})`;
        }).join('\n');

        const content = `${baseSystemInfo}

You are the **Architect Agent**. 

### 🛡️ SECURITY & OBJECTIVE PROTOCOL
1. **STRICT OBJECTIVE**: fulfill ONLY the user's specific request.
2. **PLANNING**: Create a sequence of tasks to achieve the goal.
3. **MEMORY**: Review "COMPLETED ACTIONS". Do not repeat them.

### Tools Available:
${toolDescriptions}

### Final Plan Format:
\`\`\`json
{
  "objective": "...",
  "scratchpad": "...",
  "tasks": [
    { "id": 1, "task_type": "simple_action", "action": "...", "description": "...", "parameters": {}, "save_as": "..." }
  ]
}
\`\`\`
`;
        return { role: 'system', content };
    }

    public async getPlannerSystemPrompt(isRevision: boolean = false, allowedTools: ToolDefinition[]): Promise<ChatMessage> {
        return this.getArchitectSystemPrompt(allowedTools);
    }
}
