import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const queryArchitectureTool: ToolDefinition = {
    name: "query_architecture",
    description: "Queries the project's code graph to find dependencies, usages, or file outlines. This is extremely efficient for saving tokens! Use this to quickly see what a file exports, what it imports, or where a function/class is called, WITHOUT reading the full file contents.",
    isAgentic: true,
    isDefault: true,
    parameters:[
        { name: "target", type: "string", description: "File path or symbol name (class/function) to inspect.", required: true },
        { name: "query_type", type: "string", description: "Type of analysis: 'outline' (shows classes/functions in a file), 'dependencies' (what this uses/imports/calls), or 'usages' (what calls/imports this).", required: true }
    ],
    async execute(params: { target: string, query_type: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.codeGraphManager) {
            return { success: false, output: "Error: CodeGraphManager is not available." };
        }
        
        // Build graph proactively if the tool needs it and it isn't ready
        if (env.codeGraphManager.getBuildState() !== 'ready') {
            await env.codeGraphManager.buildGraph();
        }
        
        const qType = params.query_type === 'outline' || params.query_type === 'dependencies' || params.query_type === 'usages' 
            ? params.query_type 
            : 'outline';
            
        const output = env.codeGraphManager.getArchitectureAnalysis(params.target, qType);
        return { success: true, output };
    }
};