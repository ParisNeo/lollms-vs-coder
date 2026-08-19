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

        let rawPath: string[] = [];
        if (Array.isArray(params.path)) rawPath = params.path;
        else if (typeof params.path === 'string') rawPath = (params.path as string).split(/[/>]/).map(s => s.trim()).filter(s => s);
        else if (Array.isArray((params as any).categories)) rawPath = (params as any).categories;
        else rawPath = ['general'];

        const content = String(params.content || (params as any).body || (params as any).text || '');
        const summary = String(params.summary || (params as any).description || content.substring(0, 100));
        const isGlobal = !!(params.is_global || (params as any).isGlobal || (params as any).global);

        try {
            await (env.agentManager as any).rlmDb.storeKnowledge(
                rawPath, 
                content, 
                summary, 
                isGlobal
            );
            return { success: true, output: `✅ Successfully committed knowledge to ${isGlobal ? 'Global' : 'Local'} zone at: ${rawPath.join(' > ')}` };
        } catch (e: any) {
            return { success: false, output: `Failed to store knowledge: ${e.message}` };
        }
    }
};
