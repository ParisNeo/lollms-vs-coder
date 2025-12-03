import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const readCodeGraphTool: ToolDefinition = {
    name: "read_code_graph",
    description: "Reads the current project's code structure graph (e.g., class diagrams, imports) as text (Mermaid format).",
    isAgentic: false,
    isDefault: true,
    parameters: [
        { name: "type", type: "string", description: "The type of graph to retrieve. Options: 'import_graph', 'class_diagram', 'call_graph'. Defaults to 'class_diagram'.", required: false }
    ],
    async execute(params: { type?: 'import_graph' | 'class_diagram' | 'call_graph' }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.codeGraphManager) {
            return { success: false, output: "Error: CodeGraphManager is not available in the environment." };
        }

        // If graph is empty, try to build it first
        if (env.codeGraphManager.getGraphData().nodes.length === 0) {
             await env.codeGraphManager.buildGraph();
        }

        const type = params.type || 'class_diagram';
        const graphText = env.codeGraphManager.generateMermaid(type);
        
        return { success: true, output: `Code Graph (${type}):\n\`\`\`mermaid\n${graphText}\n\`\`\`` };
    }
};
