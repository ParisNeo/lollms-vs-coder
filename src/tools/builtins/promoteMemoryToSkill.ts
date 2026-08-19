import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const promoteMemoryToSkillTool: ToolDefinition = {
    name: "promote_memory_to_skill",
    description: "Converts a project-specific memory into a permanent Global Skill. Use this when you discover a technical truth or protocol that should be applied to ALL future projects.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "memory_id", type: "string", description: "The unique ID of the memory to promote.", required: true },
        { name: "skill_name", type: "string", description: "A clear name for the new skill.", required: true }
    ],
    async execute(params: { memory_id: string, skill_name: string }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        const memManager = (env.agentManager as any)?.projectMemoryManager;
        const skillManager = env.skillsManager || (env.contextManager as any)?.skillsManager || (env.agentManager as any)?.skillsManager;

        if (!memManager || !skillManager) return { success: false, output: "Managers not available." };

        const memId = String(params.memory_id || (params as any).memoryId || (params as any).id || "").trim();
        const skillName = String(params.skill_name || (params as any).skillName || (params as any).name || (params as any).title || "Promoted Skill").trim();

        if (!memId) return { success: false, output: "Error: memory_id parameter is required." };

        const memories = await memManager.getMemories();
        const mem = memories.find((m: any) => m.id === memId);

        if (!mem) return { success: false, output: `Memory ID '${memId}' not found.` };

        await skillManager.addSkill({
            id: `promoted-${Date.now()}`,
            name: skillName,
            description: `Auto-promoted from project memory: ${mem.title || memId}`,
            content: mem.content || "",
            category: `promoted/${mem.category || 'general'}`,
            scope: 'global',
            language: 'markdown'
        });

        return { success: true, output: `✅ Successfully promoted memory '${mem.title || memId}' to a Global Skill named '${skillName}'.` };
    }
};