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
        Your current hypothesis involving \`${lastTool}\` has failed multiple times. 
        STRICT DEBUGGING PROTOCOL:
        1. **SKEPTICISM**: Your current understanding of the internal state is WRONG.
        2. **INSTRUMENTATION**: Before proposing another fix, you MUST use \`edit_code\` to add print statements/logs to the failing area.
        3. **EMPIRICAL DATA**: Run the code, observe the NEW logs, and only then proceed. Do not guess again.`,

            `### 🚨 REPETITION CIRCUIT BREAKER
        You are repeating yourself. This is a waste of context and compute. 
        INSTRUCTION: Abandon your current plan. You are now FORBIDDEN from using \`${lastTool}\` on this specific path. Change your technical approach immediately.`,

            `### 🕵️ RCA MANDATE: ROOT CAUSE ANALYSIS
            Your last actions produced zero delta. 
            MANDATORY: Your next 'thought' MUST start with "RCA:" and explain exactly why the previous approach was wrong. Then, pivot to a different strategy.
            STRICT: If you are retrying a command, you MUST change the parameters or add debugging logs. NEVER repeat the same command twice.`,

            `### 🧠 META-COGNITIVE RESET
            You are in a rut. 
            QUESTION: If your code fix didn't work the last two times, what hidden variable are you ignoring? Run a diagnostic command to inspect the environment state before trying again.`,

            `### 📉 CONTEXT AMNESIA DETECTED
            You are asking for data that you already have. This indicates a failure in your internal state tracking.
            MANDATORY: Stop using 'read_file'. You must now use 'execute_command' to run a test or 'search_files' to find something NEW. Reset your spatial awareness of the project.`,

            `### 🐚 SHELL HYGIENE VIOLATION
            Your last command failed because you tried to run complex logic inside 'execute_command' on a Windows host.
            The error "is not recognized as an internal or external command" proves that your quoting or newlines broke the shell.
            MANDATORY: You are now FORBIDDEN from using Python one-liners. You MUST use 'generate_code' to create a script file in '.lollms/scripts/' and then run it.`
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
    ### 🧬 META-HARNESS REFLECTION: FAILURE OVERCOME
    You just successfully executed \`${successfulTool}\` after ${relevantFailures.length} previous failures.

    **CRITICAL TASK**: 
    1. **LESSON (Pink Card)**: You MUST output a \`<project_memory action="add" importance="100" category="technical_lesson">\` tag. State the precise technical reason why previous attempts failed (e.g. "Always use absolute paths for tool X") so we never do it again.
    2. **MILESTONE (Purple Card)**: You MUST output a \`<milestone title="Surpassed hurdle in ${successfulTool}" ... />\` to explain to the user what was broken and how you fixed it.

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
