import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const delegateTaskTool: ToolDefinition = {
    name: "delegate_task",
    description: "Delegates a complex analytical, coding, or planning task to a specific specialist agent.",
    isAgentic: true,
    isDefault: true,
    parameters:[
        { name: "specialist_id", type: "string", description: "ID of the agent (e.g., 'python_expert').", required: true },
        { name: "objective", type: "string", description: "The task for the specialist.", required: true }
    ],
    async execute(params: { specialist_id: string, objective: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.personalityManager) return { success: false, output: "Personality Manager not available." };
        
        const persona = env.personalityManager.getPersonality(params.specialist_id);
        let sysPrompt = "You are an AI specialist.";
        let personaName = "Specialist";

        if (persona) {
            sysPrompt = persona.systemPrompt;
            personaName = persona.name;
        } else {
            return { success: false, output: `Specialist '${params.specialist_id}' not found. You might need to use create_agent first. Available default agents: default_coder, python_expert, cpp_expert, embedded_expert, stm32_expert, pic_expert, micropython_expert, frontend_specialist, ml_scientist, code_reviewer, senior_architect, writing_expert.` };
        }

        let projectContext = "";
        if (env.workspaceRoot) {
            const ctx = await env.contextManager.getContextContent({ modelName: env.lollmsApi.getModelName() });
            projectContext = `\n\nPROJECT FILES:\n${ctx.selectedFilesContent}`;
        }

        const response = await env.lollmsApi.sendChat([
            { role: 'system', content: sysPrompt },
            { role: 'user', content: `${params.objective}${projectContext}` }
        ], null, signal);

        return { success: true, output: `Specialist '${personaName}' responded:\n${response}` };
    }
};