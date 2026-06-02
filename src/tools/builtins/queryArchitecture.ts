import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const queryArchitectureTool: ToolDefinition = {
    name: "query_architecture",
    description: "Queries the project's code graph to find dependencies, usages, file outlines, or executes a powerful SPARQL-lite query over the built graph. For query_type 'sparql', pass your SPARQL-lite query inside the 'target' parameter based on our LoLLMs Source Code Ontology.",
    isAgentic: true,
    isDefault: true,
    parameters:[
        { name: "target", type: "string", description: "File path, symbol name, or a valid SPARQL-lite query for query_type 'sparql' adhering to the LoLLMs Source Code Ontology: Classes (s:File, s:Class, s:Function, s:Method, s:Library) and Properties (s:type, s:name, s:path, s:contains, s:imports, s:calls, s:inherits). Example: SELECT ?x WHERE { ?x s:type s:Class . ?x s:name 'Player' }", required: true },
        { name: "query_type", type: "string", description: "Type of analysis: 'outline' (shows classes/functions in a file), 'dependencies' (what this uses/imports), 'usages' (what calls/imports this), or 'sparql' (executes a graph-submatch ontology query).", required: true }
    ],
    async execute(params: { target: string, query_type: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.codeGraphManager) {
            return { success: false, output: "Error: CodeGraphManager is not available." };
        }
        
        // Build graph proactively if the tool needs it and it isn't ready
        if (env.codeGraphManager.getBuildState() !== 'ready') {
            await env.codeGraphManager.buildGraph();
        }
        
        if (params.query_type === 'sparql') {
            const output = env.codeGraphManager.executeSparql(params.target);
            return { success: true, output };
        }

        const qType = params.query_type === 'outline' || params.query_type === 'dependencies' || params.query_type === 'usages' 
            ? params.query_type 
            : 'outline';
            
        const output = env.codeGraphManager.getArchitectureAnalysis(params.target, qType);
        return { success: true, output };
    }
};
