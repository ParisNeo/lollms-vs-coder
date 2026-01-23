import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const submitResponseTool: ToolDefinition = {
    name: "submit_response",
    description: "Sends the final answer or a status update back to the user in the chat. Use this after you have gathered all necessary information or completed the requested tasks.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { 
            name: "response", 
            type: "string", 
            description: "The final message or answer to provide to the user (Markdown supported).", 
            required: true 
        }
    ],
    async execute(params: { response: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.response) {
            return { success: false, output: "Error: 'response' parameter is required." };
        }

        if (env.agentManager && env.agentManager.getCurrentDiscussion()) {
            // Send the message back to the chat UI via the AgentManager's reference to the panel
            const model = env.agentManager.getCurrentDiscussion()?.model || env.lollmsApi.getModelName();
            
            // We use a custom ID to ensure we don't duplicate if the agent retries
            const msgId = `agent_final_${Date.now()}`;
            
            await env.agentManager.submitFinalMessage({
                id: msgId,
                role: 'assistant',
                content: params.response,
                model: model
            });

            return { success: true, output: "Response successfully submitted to user." };
        }

        return { success: false, output: "Error: Agent environment not fully initialized." };
    }
};
