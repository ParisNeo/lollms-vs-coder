import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const createAgentTool: ToolDefinition = {
    name: "create_agent",
    description: "Creates a new specialist agent (persona) to add to the agents database.",
    isAgentic: true,
    isDefault: true,
    parameters:[
        { name: "id", type: "string", description: "Unique ID (e.g., 'database_expert').", required: true },
        { name: "name", type: "string", description: "Display name.", required: true },
        { name: "description", type: "string", description: "Short description.", required: true },
        { name: "system_prompt", type: "string", description: "The system instructions/persona defining the specialist.", required: true }
    ],
    async execute(params: { id: string, name: string, description: string, system_prompt: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.personalityManager) return { success: false, output: "Personality Manager not available." };
        
        await env.personalityManager.addPersonality({
            id: params.id,
            name: params.name,
            description: params.description,
            systemPrompt: params.system_prompt,
            category: "Agent Created"
        });
        return { success: true, output: `Agent '${params.name}' created successfully and added to database.` };
    }
};