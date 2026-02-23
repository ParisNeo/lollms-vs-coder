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
# 🛑 CRITICAL: SPECIALIST FAILURE LOG (BLAME)
The following specialists failed to execute their assigned tasks. 
Analyze the errors below. You MUST change the model, the persona, or the tool parameters to fix this. 

${this.failures.map((f, i) => `
[BLAME #${i + 1}]
- Specialist Action: \`${f.toolName}\`
- Failed Parameters: \`${JSON.stringify(f.parameters)}\`
- Error Output: "${f.errorOutput.substring(0, 500)}"
- Verdict: The previous strategy is BLOCKED. Spawn a different agent or use a different approach.
`).join('\n')}
`;
    }

    public clear() { this.failures = []; }
}
