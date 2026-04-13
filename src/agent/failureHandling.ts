export interface FailedAttempt {
    toolName: string;
    parameters: any;
    errorOutput: string;
    timestamp: number;
}

export class FailureMemory {
    private failures: FailedAttempt[] = [];

    public recordFailure(toolName: string, params: any, error: string) {
        this.failures.push({ toolName, parameters: params, errorOutput: error, timestamp: Date.now() });
    }

    public hasFailedBefore(toolName: string, params: any): boolean {
        const paramStr = JSON.stringify(params);
        return this.failures.some(f => f.toolName === toolName && JSON.stringify(f.parameters) === paramStr);
    }

    public getMemoryContext(): string {
        if (this.failures.length === 0) return "";

        return `
# 🛑 EVOLVING INTELLIGENCE: MISTAKES TO AVOID
I have detected that we are repeating patterns that previously failed. You must deviate from the following logic:

${this.failures.map((f, i) => `
### FAILED ATTEMPT #${i + 1}
- **Tool**: \`${f.toolName}\`
- **Invalid Parameters**: \`${JSON.stringify(f.parameters)}\`
- **Error Received**: "${f.errorOutput.substring(0, 500)}"
`).join('\n')}

**GENIE REFLEXIVE PROTOCOL**: 
1. **STRICT BLOCK**: You are FORBIDDEN from repeating the 'Failed Attempt' logic shown above.
2. **ROOT CAUSE ANALYSIS**: If the error is a \`NameError\` (like \'nn\' is not defined), you MUST check the import section of the file before applying a fix.
3. **DEVIATE**: If \`generate_code\` failed because a SEARCH block didn't match, use \`read_file\` to get the FRESH content of the file and try a smaller, more precise SEARCH block.
`;
    }

    /**
     * Generates a prompt for the agent to analyze why a recent success worked
     * where previous attempts failed.
     */
    public getReflectionPrompt(successfulTool: string, successfulParams: any): string {
        const relevantFailures = this.failures.filter(f => f.toolName === successfulTool);
        if (relevantFailures.length === 0) return "";

        return `
### 🧬 META-HARNESS REFLECTION
You just successfully executed \`${successfulTool}\` after previous failures.

**PREVIOUS FAILURES:**
${relevantFailures.map(f => `- Error: "${f.errorOutput.substring(0, 200)}..." with params: ${JSON.stringify(f.parameters)}`).join('\n')}

**SUCCESSFUL EXECUTION:**
- Params: \`${JSON.stringify(successfulParams)}\`

**TASK**: 
1. Briefly explain why this version worked.
2. Output a \`<project_memory>\` tag to ensure future agents don't repeat the failing patterns.
`;
    }

    public clear() { this.failures = []; }
}
