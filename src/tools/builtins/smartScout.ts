import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const smartScoutTool: ToolDefinition = {
    name: "smart_scout",
    description: "Performs high-speed architectural grounding. Returns the file tree, the high-level code graph summary, and the full content of up to 3 entry-point files. Use this as your very first step to gain instant 'vision' of a new project.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "entry_files", type: "array", description: "List of 1-3 primary files to read immediately (e.g. ['main.py', 'config.json']).", required: true }
    ],
    async execute(params: { entry_files: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const tree = await env.contextManager.generateProjectTree(signal);
        
        let graphSummary = "Graph not available.";
        if (env.codeGraphManager) {
            if (env.codeGraphManager.getBuildState() !== 'ready') await env.codeGraphManager.buildGraph();
            graphSummary = env.codeGraphManager.generateTextSummary();
        }

        const filesContent = await env.contextManager.readSpecificFiles(params.entry_files.slice(0, 3));

        const output = `
# 📡 SMART SCOUT REPORT
## 🌳 WORKSPACE STRUCTURE
${tree}

## 📊 ARCHITECTURAL MAP
${graphSummary}

## 📄 PRIMARY FILE CONTENTS
${filesContent}

**Architect Note**: You now have sufficient grounding. Your next step should be implementation or specific deep research.
`;
        return { success: true, output };
    }
};