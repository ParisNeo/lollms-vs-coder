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

    private cleanParams(params: any): any {
        if (!params || typeof params !== 'object') return params;
        const p = { ...params };
        // Remove reasoning fields that might change slightly while the core action remains identical
        delete p.thought;
        delete p.scratchpad;
        return p;
    }

    public hasFailedBefore(toolName: string, params: any): boolean {
        const paramStr = JSON.stringify(this.cleanParams(params));
        return this.failures.some(f => f.toolName === toolName && JSON.stringify(this.cleanParams(f.parameters)) === paramStr);
    }

    public getMemoryContext(): string {
        if (this.failures.length === 0) return "";

        // Only show the last 3 failures to keep context focused and avoid "Summary Snowball"
        const recentFailures = this.failures.slice(-3);

        return `
# 🛑 EVOLVING INTELLIGENCE: MISTAKES TO AVOID (STRICT)
The following actions were ATTEMPTED and FAILED. You must change your technical approach.

${recentFailures.map((f, i) => `
### FAILURE #${i + 1}
- **Tool**: \`${f.toolName}\`
- **Tried Params**: \`${JSON.stringify(f.parameters)}\`
- **Resulting Error**: "${f.errorOutput.substring(0, 300)}"
`).join('\n')}

**REFLEXIVE CONSTRAINTS**: 
1. **STRICT BLOCK**: If you repeat any of the 'Tried Params' above, the system will terminate your turn.
2. **ROOT CAUSE ANALYSIS**: If the error is a \`NameError\` (like \'nn\' is not defined), you MUST check the import section of the file before applying a fix.
3. **DEVIATE**: If \`generate_code\` failed because a SEARCH block didn't match, use \`read_file\` to get the FRESH content of the file and try a smaller, more precise SEARCH block.
4. **BREAK THE LOOP**: If you are failing repeatedly, STOP GUESSING. Use \`execute_command\` to run a test or diagnostic, or read a different file to gather more clues.
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
1. RCA: Explain precisely why this attempt succeeded where the previous ones failed (e.g., quoting, shell environment, tool choice).
2. MEMORY: You MUST output a \`<project_memory action="add" importance="2.0" category="technical_lesson">\` tag. 
   - State a generalized rule for your future self to prevent repeating this specific category of mistake.
   - Example: "When using tool X, always do Y to avoid Z."
`;
    }

    public clear() { this.failures = []; }
}
