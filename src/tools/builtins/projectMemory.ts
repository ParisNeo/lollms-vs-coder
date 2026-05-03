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

        try {
            await manager.updateMemory(
                params.action,
                params.id,
                params.title,
                params.content,
                "general",
                params.importance
            );
            
            const actionLabel = params.action === 'delete' ? 'removed from' : 'synced to';
            return { 
                success: true, 
                output: `✅ Fact '${params.id}' successfully ${actionLabel} Project Memory.` 
            };
        } catch (e: any) {
            return { success: false, output: `Failed to update project memory: ${e.message}` };
        }
    }
};