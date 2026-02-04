import { ToolDefinition, ToolExecutionEnv } from '../tool';

/**
 * Allows the agent to pause execution for a specific duration.
 * Useful for waiting for background tasks or respecting API rate limits.
 */
export const waitTool: ToolDefinition = {
    name: "wait",
    description: "Pauses execution for a specified number of seconds.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { 
            name: "seconds", 
            type: "number", 
            description: "Number of seconds to wait.", 
            required: true 
        }
    ],
    async execute(params: { seconds: number }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const ms = (params.seconds || 1) * 1000;
        
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve({ success: true, output: `Waited for ${params.seconds} seconds.` });
            }, ms);

            signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                resolve({ success: false, output: "Wait cancelled." });
            });
        });
    }
};
