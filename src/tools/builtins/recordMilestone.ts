import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const recordMilestoneTool: ToolDefinition = {
    name: "record_milestone",
    description: "Documents a major project milestone. Use this to summarize a significant phase completion for the user. Describe technical wins, hurdles faced, and how you overcame them.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "title", type: "string", description: "Clear, bold name for the milestone.", required: true },
        { name: "achievements", type: "string", description: "List of completed technical requirements.", required: true },
        { name: "challenges", type: "string", description: "Hurdles or bugs encountered during this segment.", required: true },
        { name: "solutions", type: "string", description: "How you fixed the challenges (e.g., 'Implemented mutex to solve race condition').", required: true }
    ],
    async execute(params: { title: string, achievements: string, challenges: string, solutions: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        // 1. Trigger a physical Git Commit for this milestone
        if (env.workspaceRoot && env.agentManager) {
            const commitMsg = `Milestone: ${params.title}\n\nAchievements: ${params.achievements}\nSolutions: ${params.solutions}`;
            await env.agentManager.runCommand(`git add . && git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, signal);
        }

        // 2. Output a structured tag that the webview renderer will catch and turn into a purple card
        const tag = `<milestone 
            title="${params.title.replace(/"/g, '&quot;')}" 
            achievements="${params.achievements.replace(/"/g, '&quot;')}" 
            challenges="${params.challenges.replace(/"/g, '&quot;')}" 
            solutions="${params.solutions.replace(/"/g, '&quot;')}" 
        />`;
        return { success: true, output: tag };
    }
};