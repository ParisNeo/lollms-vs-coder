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
    async execute(params: { fact: string, category: string, persistent?: boolean }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        if (!env.agentManager) return { success: false, output: "Agent environment not ready." };

        const timestamp = new Date().toISOString();
        const entry = `[${params.category.toUpperCase()}] (${timestamp}): ${params.fact}`;

        // 1. Session Memory (Tier 1)
        env.agentManager.sessionState.workingMemory.push(entry);

        // 2. Project Memory (Tier 2/3) - For long-term discovery
        if (params.persistent && (env.agentManager as any).projectMemoryManager) {
            const handle = `DISCOVERY_${params.category.toUpperCase()}_${Date.now().toString(36).toUpperCase()}`;
            await (env.agentManager as any).projectMemoryManager.updateMemory(
                'add', 
                handle, 
                `Discovery: ${params.category}`, 
                params.fact, 
                'discovery', 
                0.8 // High initial importance
            );
            return { success: true, output: `Fact recorded. PERSISTENT HANDLE CREATED: ${handle}` };
        }

        return { 
            success: true, 
            output: `Fact recorded in Working Memory for this session.` 
        };
    }
};