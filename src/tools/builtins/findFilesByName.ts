import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const findFilesByNameTool: ToolDefinition = {
    name: "find_files_by_name",
    description: "Searches the project file index for filenames matching a specific pattern. Extremely fast. Use this to find the exact path of a file you know exists (e.g. 'AuthService.ts') or to list all files of a type (e.g. '*.vue').",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "pattern", type: "string", description: "The filename pattern to search for (glob or substring).", required: true }
    ],
    async execute(params: { pattern: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const fileProvider = env.contextManager.getContextStateProvider();
        if (!fileProvider) return { success: false, output: "File index not available." };

        const allFiles = await fileProvider.getAllVisibleFiles(signal);
        const pattern = params.pattern.toLowerCase().replace(/\*/g, ''); // Simple substring match for robustness
        
        const matches = allFiles.filter(f => f.toLowerCase().includes(pattern));

        if (matches.length === 0) {
            return { success: true, output: `No files found matching '${params.pattern}'. Try a broader term.` };
        }

        const result = matches.slice(0, 50).map(f => `- ${f}`).join('\n');
        return { 
            success: true, 
            output: `Found ${matches.length} matches (showing top 50):\n${result}\n\n**Next Step**: Use 'add_files' with the exact paths listed above.` 
        };
    }
};