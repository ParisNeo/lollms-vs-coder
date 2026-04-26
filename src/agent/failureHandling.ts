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

        const recentFailures = this.failures.slice(-3);
        const lastTool = recentFailures[recentFailures.length - 1].toolName;

        // SHAKER POOL: Aggressive wake-up calls for repetitive agents
        const shakerPrompts = [
            `### 🔬 SCIENTIFIC AUDIT: LOGIC FALSIFIED
        Your current hypothesis involving \`${lastTool}\` has been empirically disproven. 
        STRICT MANDATE: Do NOT repeat the parameters listed below. Discard your current assumptions. You must now use 'read_file' or 'execute_command' to gather NEW EVIDENCE before proposing another fix.`,

            `### 🚨 REPETITION CIRCUIT BREAKER
        You are repeating yourself. This is a waste of context and compute. 
        INSTRUCTION: Abandon your current plan. You are now FORBIDDEN from using \`${lastTool}\` on this specific path. Change your technical approach immediately.`,

            `### 🕵️ RCA MANDATE: ROOT CAUSE ANALYSIS
        Your last actions produced zero delta. 
        MANDATORY: Your next 'thought' MUST start with "RCA:" and explain exactly why the previous approach was wrong. Then, pivot to a different strategy.`,

            `### 🧠 META-COGNITIVE RESET
        You are in a rut. 
        QUESTION: If your code fix didn't work the last two times, what hidden variable are you ignoring? Run a diagnostic command to inspect the environment state before trying again.`
        ];

        // Pick a random shaker to keep the small model from anchoring on one error message
        const selectedShaker = shakerPrompts[Math.floor(Math.random() * shakerPrompts.length)];

        return `
${selectedShaker}

# 🚫 BLACKLISTED ACTIONS (DO NOT REPEAT)
${recentFailures.map((f, i) => `
* ATTEMPT #${i + 1}: Tool \`${f.toolName}\` | Params: \`${JSON.stringify(this.cleanParams(f.parameters))}\`
  Error observed: "${f.errorOutput.substring(0, 150)}..."
`).join('\n')}

**DIVERGENCE MANDATE**: 
1. If you repeat a Blacklisted Action, the harness will automatically eject you.
2. Small-Model Tip: If you are confused, use \`execute_command\` to run \`pwd\` or \`ls -R\` to reset your spatial awareness of the project.
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
