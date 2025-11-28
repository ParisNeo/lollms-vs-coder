import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const editPlanTool: ToolDefinition = {
    name: "edit_plan",
    description: "Modifies the remaining steps of the current plan based on new instructions. Use this if you realize the plan needs to change.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "instruction", type: "string", description: "The instruction describing how to change the plan (e.g., 'Also add a test file', 'Skip the database setup').", required: true }
    ],
    async execute(params: { instruction: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.instruction) {
            return { success: false, output: "Error: 'instruction' is required." };
        }

        // Delegate to the AgentManager to handle the complex logic of replanning
        return env.agentManager.replan(params.instruction, signal);
    }
};
