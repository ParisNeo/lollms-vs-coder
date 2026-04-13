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
        const skillManager = env.skillsManager;
        
        if (!memManager || !skillManager) return { success: false, output: "Managers not available." };

        const memories = await memManager.getMemories();
        const mem = memories.find((m: any) => m.id === params.memory_id);

        if (!mem) return { success: false, output: `Memory ID '${params.memory_id}' not found.` };

        await skillManager.addSkill({
            id: `promoted-${Date.now()}`,
            name: params.skill_name,
            description: `Auto-promoted from project memory: ${mem.title}`,
            content: mem.content,
            category: `promoted/${mem.category}`,
            scope: 'global',
            language: 'markdown'
        });

        return { success: true, output: `✅ Successfully promoted memory '${mem.title}' to a Global Skill named '${params.skill_name}'.` };
    }
};