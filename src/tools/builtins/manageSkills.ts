import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const manageSkillsTool: ToolDefinition = {
    name: "manage_skills",
    description: "Dynamically loads or unloads specialized skills from the project library into the active reasoning context. Use this to equip the 'Diamond Protocols' needed for your current task.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "action", type: "string", description: "'load' or 'unload'.", required: true },
        { name: "skill_ids", type: "array", description: "List of skill IDs (e.g., ['python_best_practices', 'tailwind_patterns']).", required: true }
    ],
    async execute(params: { action: 'load' | 'unload', skill_ids: string[] }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        const discussion = env.agentManager?.getCurrentDiscussion();
        if (!discussion) return { success: false, output: "No active discussion context." };

        if (!discussion.importedSkills) discussion.importedSkills = [];

        const rawAction = params.action || (params as any).mode || (params as any).operation || 'load';
        const action = String(rawAction).toLowerCase().trim() === 'unload' ? 'unload' : 'load';

        let targetIds: string[] = [];
        if (Array.isArray(params.skill_ids)) targetIds = params.skill_ids;
        else if (Array.isArray((params as any).skillIds)) targetIds = (params as any).skillIds;
        else if (Array.isArray((params as any).skills)) targetIds = (params as any).skills;
        else if (typeof (params as any).skill_ids === 'string') targetIds = [(params as any).skill_ids];
        else if (typeof (params as any).skill_id === 'string') targetIds = [(params as any).skill_id];
        else if (typeof (params as any).id === 'string') targetIds = [(params as any).id];

        for (const id of targetIds) {
            const cleanId = String(id).trim();
            if (!cleanId) continue;
            if (action === 'load') {
                if (!discussion.importedSkills.includes(cleanId)) discussion.importedSkills.push(cleanId);
            } else {
                discussion.importedSkills = discussion.importedSkills.filter(s => s !== cleanId);
            }
        }
        
        // Refresh the HUD in the UI
        if (env.agentManager?.ui) {
            (env.agentManager.ui as any).updateContextAndTokens();
        }

        return { success: true, output: `Successfully ${params.action}ed ${params.skill_ids.length} skills. They will be visible in your next turn.` };
    }
};