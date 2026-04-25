import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const recordDiscoveryTool: ToolDefinition = {
    name: "record_discovery",
    description: "Saves a technical fact, code snippet, or architectural rule into your Working Memory. Use this after reading a file or running a command to ensure you don't have to repeat the action. This grounds your future reasoning.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "fact", type: "string", description: "The specific technical information to remember (e.g. 'The API endpoint is /v1/auth', or a code snippet).", required: true },
        { name: "category", type: "string", description: "The type of discovery (e.g., 'api', 'logic', 'dependency').", required: true }
    ],
    async execute(params: { fact: string, category: string }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        if (!env.agentManager) return { success: false, output: "Agent environment not ready." };
        
        const timestamp = new Date().toLocaleTimeString();
        const entry = `[${params.category.toUpperCase()}] (${timestamp}): ${params.fact}`;
        
        env.agentManager.sessionState.workingMemory.push(entry);
        
        return { 
            success: true, 
            output: `Fact recorded in Working Memory. You will now see this in your 'NEURAL MEMORY SYSTEM' block in every turn.` 
        };
    }
};