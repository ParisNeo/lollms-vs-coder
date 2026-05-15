import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const readFileRelationsTool: ToolDefinition = {
    name: "read_file_relations",
    description: "Surgically extracts the architectural connections of a specific file. Returns what the file imports (dependencies) and what other files import it (usages). Extremely efficient for navigating large codebases without reading full content.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "path", type: "string", description: "Relative path to the file (e.g. 'src/utils.ts').", required: true }
    ],
    async execute(params: { path: string }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        if (!env.codeGraphManager) return { success: false, output: "Code Graph not available." };
        
        if (env.codeGraphManager.getBuildState() !== 'ready') {
            await env.codeGraphManager.buildGraph();
        }

        const deps = env.codeGraphManager.getArchitectureAnalysis(params.path, 'dependencies');
        const usages = env.codeGraphManager.getArchitectureAnalysis(params.path, 'usages');

        return { 
            success: true, 
            output: `### ARCHITECTURAL RELATIONS: ${params.path}\n\n${deps}\n\n${usages}` 
        };
    }
};