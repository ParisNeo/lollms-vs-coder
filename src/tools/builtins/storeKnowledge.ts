import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const storeKnowledgeTool: ToolDefinition = {
    name: "store_knowledge",
    description: "Persistently saves information into the RLM Knowledge Base. Use this when the user says 'remember this', 'learn this', or when you discover a new API pattern/fix.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "path", type: "array", description: "Array of categories, e.g. ['coding', 'python', 'api'].", required: true },
        { name: "content", type: "string", description: "The full detailed information to store.", required: true },
        { name: "summary", type: "string", description: "A very brief summary for the tree view.", required: true },
        { name: "is_global", type: "boolean", description: "True to save for all projects, False for just this project.", required: false }
    ],
    async execute(params: { path: string[], content: string, summary: string, is_global?: boolean }, env: ToolExecutionEnv): Promise<{ success: boolean, output: string }> {
        if (!env.agentManager || !(env.agentManager as any).rlmDb) {
            return { success: false, output: "Error: RLM Database Manager not found in Agent environment." };
        }
        
        try {
            await (env.agentManager as any).rlmDb.storeKnowledge(
                params.path, 
                params.content, 
                params.summary, 
                !!params.is_global
            );
            return { success: true, output: `✅ Successfully committed knowledge to ${params.is_global ? 'Global' : 'Local'} zone at: ${params.path.join(' > ')}` };
        } catch (e: any) {
            return { success: false, output: `Failed to store knowledge: ${e.message}` };
        }
    }
};
