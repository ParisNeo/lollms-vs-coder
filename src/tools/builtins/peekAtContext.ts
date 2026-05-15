import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const peekAtContextTool: ToolDefinition = {
    name: "peek_at_context",
    description: "⚠️ HIGH TOKEN COST. Returns the exact content (files + briefing + skills) currently loaded in the shared context. Use only if you are confused about the current 'World State' or need to verify what the Specialist can see.",
    isAgentic: true,
    isDefault: true,
    parameters: [],
    async execute(params: {}, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const modelName = env.agentManager?.getCurrentDiscussion()?.model || env.lollmsApi.getModelName();
        const contextData = await env.contextManager.getContextContent({ 
            includeTree: false, // We already show the tree in every turn
            modelName,
            signal 
        });

        return { 
            success: true, 
            output: `### CURRENT SHARED CONTEXT BUFFER\n\n${contextData.selectedFilesContent}\n\n### ACTIVE BRIEFING\n${contextData.text.split('### 🌐 HOW TO INTERACT')[0]}` 
        };
    }
};