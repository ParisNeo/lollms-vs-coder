import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const manageToolsTool: ToolDefinition = {
    name: "manage_tools",
    description: "Manages the agent's active toolbelt. Use this to 'load' specialized tools from the latent catalogue into your active memory or 'unload' unused tools to save context space.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "action", type: "string", description: "'load' to bring a tool to Front (Active), 'unload' to push to Back (Latent).", required: true },
        { name: "tool_names", type: "array", description: "List of tool names to manage (e.g., ['analyze_image', 'process_image_asset']).", required: true }
    ],
    async execute(params: { action: 'load' | 'unload', tool_names: string[] }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        if (!env.agentManager) return { success: false, output: "Agent Manager not found." };
        
        const session = env.agentManager.sessionState as any;
        // Initialize if not present
        if (!session.activeToolIds) {
            session.activeToolIds = new Set(env.agentManager.getEnabledTools().map(t => t.name));
        }

        const allAvailable = env.agentManager.getTools();
        const results: string[] = [];

        for (const name of params.tool_names) {
            if (params.action === 'load') {
                if (allAvailable.find(t => t.name === name)) {
                    session.activeToolIds.add(name);
                    results.push(`✅ Loaded: ${name}`);
                } else {
                    results.push(`❌ Unknown tool: ${name}`);
                }
            } else {
                session.activeToolIds.delete(name);
                results.push(`💤 Unloaded: ${name}`);
            }
        }

        return { success: true, output: `Toolbelt Update:\n${results.join('\n')}` };
    }
};