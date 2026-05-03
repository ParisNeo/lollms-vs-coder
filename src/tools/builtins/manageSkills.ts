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

        for (const id of params.skill_ids) {
            if (params.action === 'load') {
                if (!discussion.importedSkills.includes(id)) discussion.importedSkills.push(id);
            } else {
                discussion.importedSkills = discussion.importedSkills.filter(s => s !== id);
            }
        }
        
        // Refresh the HUD in the UI
        if (env.agentManager?.ui) {
            (env.agentManager.ui as any).updateContextAndTokens();
        }

        return { success: true, output: `Successfully ${params.action}ed ${params.skill_ids.length} skills. They will be visible in your next turn.` };
    }
};