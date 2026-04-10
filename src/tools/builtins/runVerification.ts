import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const runVerificationTool: ToolDefinition = {
    name: "run_verification",
    description: "Performs a cold, critical logical audit of the generated code. Checks for 'ghost' imports, edge cases, and compliance with the objective. Should be used as the final step before finishing a task.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "code_to_verify", type: "string", description: "The code block to audit.", required: true },
        { name: "objective", type: "string", description: "The original requirement to verify against.", required: true }
    ],
    async execute(params: { code_to_verify: string, objective: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        // We leverage the existing Verifier Agent logic
        const systemPrompt = `You are the Senior Quality Verifier. Audit this code against the objective: "${params.objective}". Find 1 regression risk or 1 logical flaw. If perfect, say 'VERIFICATION PASSED'.`;
        
        try {
            const response = await env.lollmsApi.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: params.code_to_verify }
            ], null, signal);
            
            return { success: true, output: response };
        } catch (e: any) {
            return { success: false, output: `Verification failed: ${e.message}` };
        }
    }
};