import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const readMemoryCategoryTool: ToolDefinition = {
    name: "read_memory_category",
    description: "Lists the identifiers and titles of project memories within a specific category. Use this when the high-level index suggests relevant knowledge exists in deep storage.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "category", type: "string", description: "The category path to browse (e.g., 'coding/python/errors').", required: true }
    ],
    async execute(params: { category: string }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        const manager = (env.agentManager as any)?.projectMemoryManager;
        if (!manager) return { success: false, output: "Memory Manager not available." };

        const memories = await manager.getMemories();
        const matches = memories.filter((m: any) => m.category === params.category);

        if (matches.length === 0) {
            return { success: true, output: `No memories found in category '${params.category}'.` };
        }

        const list = matches.map((m: any) => `- ID: \`${m.id}\` | Title: "${m.title}" (Importance: ${Math.round(m.importance * 100)}%)`).join('\n');
        return { success: true, output: `Memories in ${params.category}:\n${list}\n\nUse 'read_file' with the ID if you need the full content of one of these.` };
    }
};