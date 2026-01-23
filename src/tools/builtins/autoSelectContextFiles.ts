import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const autoSelectContextFilesTool: ToolDefinition = {
    name: "auto_select_context_files",
    description: "Intelligently selects relevant files for a given objective and adds them to the AI's context. You can optionally provide keywords to help find specific logic or function definitions.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "objective", type: "string", description: "The high-level objective to select files for.", required: true },
        { name: "keywords", type: "array", description: "Optional list of keywords to search for in the codebase (e.g. ['calculatePrice', 'userSchema']).", required: false }
    ],
    async execute(params: { objective: string, keywords?: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.objective) {
            return { success: false, output: "Error: 'objective' parameter is required." };
        }

        const fileTreeProvider = env.contextManager.getContextStateProvider();
        if (!fileTreeProvider) {
            return { success: false, output: "Error: File Tree Provider is not available." };
        }

        const model = env.agentManager?.getCurrentDiscussion()?.model || env.lollmsApi.getModelName();

        try {
            const contextText = await env.contextManager.runContextAgent(
                params.objective,
                model,
                signal,
                (statusUpdate) => {
                    // Update main chat if possible
                    env.agentManager?.getCurrentDiscussion();
                },
                params.keywords
            );

            if (signal.aborted) {
                return { success: false, output: "Operation cancelled." };
            }

            return { success: true, output: `Auto-context selection complete. Re-reading context...` };
        } catch (e: any) {
            return { success: false, output: `AI failed to select files: ${e.message}` };
        }
    }
};
