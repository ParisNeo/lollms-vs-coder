import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const projectMemoryTool: ToolDefinition = {
    name: "project_memory",
    description: "Updates the long-term Project Memory (DNA). Use this to record architectural decisions, fixed bugs, or library quirks. Changes persist across all discussions in this project.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "action", type: "string", description: "'add', 'update', or 'delete'.", required: true },
        { name: "id", type: "string", description: "Unique identifier for the memory engram (e.g., 'auth_flow_logic').", required: true },
        { name: "title", type: "string", description: "Short, descriptive title.", required: false },
        { name: "content", type: "string", description: "The detailed technical fact to remember.", required: false },
        { name: "importance", type: "number", description: "Priority weight (0.0 to 5.0). High importance facts are always in context.", required: false }
    ],
    async execute(params: { action: 'add' | 'update' | 'delete', id: string, title?: string, content?: string, importance?: number }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        const manager = (env.agentManager as any)?.projectMemoryManager;
        if (!manager) {
            return { success: false, output: "Memory Manager not available in this environment." };
        }

        const rawAction = params.action || (params as any).operation || (params as any).op || 'add';
        const action = String(rawAction).toLowerCase().trim() as 'add' | 'update' | 'delete';

        const rawId = params.id || (params as any).memory_id || (params as any).name || `mem_${Date.now()}`;
        const id = String(rawId).trim();

        const rawTitle = params.title || (params as any).name || id;
        const title = String(rawTitle).trim();

        const rawContent = params.content || (params as any).body || (params as any).text || "";
        const content = String(rawContent).trim();

        const rawImportance = params.importance !== undefined ? Number(params.importance) : 1.0;
        const importance = isNaN(rawImportance) ? 1.0 : rawImportance;

        try {
            await manager.updateMemory(
                action,
                id,
                title,
                content,
                "general",
                importance
            );

            const actionLabel = action === 'delete' ? 'removed from' : 'synced to';
            return { 
                success: true, 
                output: `✅ Fact '${id}' successfully ${actionLabel} Project Memory.` 
            };
        } catch (e: any) {
            return { success: false, output: `Failed to update project memory: ${e.message}` };
        }
    }
};