import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const webConsolidateTool: ToolDefinition = {
    name: "web_consolidate",
    description: "Phase 3 of Research: Finalizes the investigation by merging all 'clues' from the search and dive phases into a single, comprehensive Technical Briefing entry in memory.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "briefing_id", type: "string", description: "Unique ID for this discovery (e.g., 'xiaomi_robot_v3_root_method').", required: true },
        { name: "summary", type: "string", description: "The final, executable set of instructions or facts gathered.", required: true }
    ],
    async execute(params: { briefing_id: string, summary: string }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        if (!env.agentManager) return { success: false, output: "Agent manager not available." };

        const entry = `[CONSOLIDATED RESEARCH: ${params.briefing_id}]\n${params.summary}`;
        env.agentManager.sessionState.workingMemory.push(entry);

        return { 
            success: true, 
            output: `✅ Research finalized and recorded. This info is now part of your permanent session memory. You can now proceed to implementation.` 
        };
    }
};