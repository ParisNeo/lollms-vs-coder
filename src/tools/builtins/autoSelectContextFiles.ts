import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const autoSelectContextFilesTool: ToolDefinition = {
    name: "auto_select_context_files",
    description: "Intelligently selects relevant files for a given objective and adds them to the AI's context.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "objective", type: "string", description: "The high-level objective to select files for.", required: true }
    ],
    async execute(params: { objective: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.objective) {
            return { success: false, output: "Error: 'objective' parameter is required." };
        }

        const fileTreeProvider = env.contextManager.getContextStateProvider();
        if (!fileTreeProvider) {
            return { success: false, output: "Error: File Tree Provider is not available." };
        }

        const fileList = await env.contextManager.getAutoSelectionForContext(params.objective);

        if (signal.aborted) {
            return { success: false, output: "Operation cancelled." };
        }

        if (fileList && fileList.length > 0) {
            await fileTreeProvider.addFilesToContext(fileList);
            const fileListString = fileList.map(f => `- ${f}`).join('\n');
            return { success: true, output: `Successfully added ${fileList.length} files to the context:\n${fileListString}` };
        } else if (fileList) {
            return { success: true, output: "AI did not select any files for the given objective." };
        } else {
            return { success: false, output: "AI failed to select files. The operation was aborted." };
        }
    }
};
