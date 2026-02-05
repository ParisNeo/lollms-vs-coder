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
# 🛑 CRITICAL: ACTIONS PREVIOUSLY FAILED
You have already attempted the following actions and they FAILED. 
The execution engine will AUTO-BLOCK any identical attempts.
YOU MUST CHOOSE A DIFFERENT STRATEGY OR TOOL.

${this.failures.map((f, i) => `
[FAILURE #${i + 1}]
- Tool: \`${f.toolName}\`
- Used Parameters: \`${JSON.stringify(f.parameters)}\`
- Error Result: "${f.errorOutput.substring(0, 300)}"
- Action Required: Do NOT use this tool with these exact parameters again.
`).join('\n')}
`;
    }

    public clear() { this.failures = []; }
}
