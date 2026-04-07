import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const updateCodeGraphTool: ToolDefinition = {
    name: "update_code_graph",
    description: "Triggers a full re-scan of the codebase to update the internal architecture graph (nodes, edges, classes, and calls). Use this after creating, moving, or significantly modifying files to ensure your structural 'vision' is up to date.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "focus_path", type: "string", description: "Optional relative path to a specific file or folder to prioritize during the update.", required: false }
    ],
    async execute(params: { focus_path?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.codeGraphManager) {
            return { success: false, output: "Error: CodeGraphManager is not available in the environment." };
        }

        try {
            // buildGraph handles the background indexing
            // It returns a promise that resolves when the scan is complete.
            await env.codeGraphManager.buildGraph(params.focus_path);
            
            const stats = env.codeGraphManager.getGraphData();
            return { 
                success: true, 
                output: `Code graph successfully updated. New state contains ${stats.nodes.length} nodes and ${stats.edges.length} relationships.` 
            };
        } catch (e: any) {
            return { success: false, output: `Failed to update code graph: ${e.message}` };
        }
    }
};