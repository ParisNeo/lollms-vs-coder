import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const readCodeGraphTool: ToolDefinition = {
    name: "read_code_graph",
    description: "Reads the current project's code structure. Use this for 'Structural Reconnaissance' to understand how classes and modules connect without reading every file. Options: 'summary' (High-density text map), 'class_diagram' (Mermaid), 'import_graph' (Mermaid).",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "type", type: "string", description: "Options: 'summary', 'import_graph', 'class_diagram', 'call_graph'. 'summary' is recommended for initial discovery.", required: false }
    ],
    async execute(params: { type?: 'summary' | 'import_graph' | 'class_diagram' | 'call_graph' }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.codeGraphManager) {
            return { success: false, output: "Error: CodeGraphManager is not available in the environment." };
        }

        // If graph is empty, try to build it first
        if (env.codeGraphManager.getGraphData().nodes.length === 0) {
             await env.codeGraphManager.buildGraph();
        }

        const type = params.type || 'summary';

        if (type === 'summary') {
            const summary = env.codeGraphManager.generateTextSummary();
            return { success: true, output: `### HIGH-DENSITY ARCHITECTURAL MAP\n\n${summary}\n\n**ADVICE**: Use this map to identify which files contain the core logic before using 'read_file'.` };
        }

        const graphText = env.codeGraphManager.generateMermaid(type);
        return { success: true, output: `Code Graph (${type}):\n\`\`\`mermaid\n${graphText}\n\`\`\`` };
    }
};
