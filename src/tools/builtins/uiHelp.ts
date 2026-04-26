import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const uiHelpTool: ToolDefinition = {
    name: "ui_help",
    description: "Teaches the user how to use specific parts of the Lollms VS Coder interface. Use this if the user seems confused or if you need to explain how to change settings.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "feature", type: "string", description: "The UI feature to explain (e.g., 'agent_settings', 'context_menu', 'memory_manager').", required: true },
        { name: "guide_steps", type: "string", description: "Clear, step-by-step instructions for the user.", required: true }
    ],
    async execute(params: { feature: string, guide_steps: string }): Promise<{ success: boolean; output: string; }> {
        const guide = `### 💡 Interface Guide: ${params.feature.replace(/_/g, ' ').toUpperCase()}\n\n${params.guide_steps}`;
        return { success: true, output: guide };
    }
};