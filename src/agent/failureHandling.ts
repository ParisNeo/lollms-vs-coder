export interface FailedAttempt {
    toolName: string;
    parameters: any;
    errorOutput: string;
    timestamp: number;
}

export class FailureMemory {
    private failures: FailedAttempt[] = [];
    private _lastFailureTime: number = 0;

    public recordFailure(toolName: string, params: any, error: string) {
        this._lastFailureTime = Date.now();
        this.failures.push({ toolName, parameters: params, errorOutput: error, timestamp: this._lastFailureTime });
    }

    private cleanParams(params: any): any {
        if (!params || typeof params !== 'object') return params;

        // 1. Shallow copy & strip internal/reasoning noise
        const p = { ...params };
        delete p.thought;
        delete p.scratchpad;
        delete p.reason;
        delete p.explanation;

        // 2. Normalize Synonymous Parameter Keys
        const normalized: any = {};
        for (const [key, value] of Object.entries(p)) {
            const lowerKey = key.toLowerCase();
            let normKey = key;

            if (lowerKey === 'file_paths' || lowerKey === 'filepaths') {
                normKey = 'paths';
            } else if (lowerKey === 'file_path' || lowerKey === 'filepath' || lowerKey === 'file' || lowerKey === 'target') {
                normKey = 'path';
            }

            // Normalize path string values (strip leading ./ and clean separators)
            if (normKey === 'path' && typeof value === 'string') {
                normalized[normKey] = value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
            } else if (normKey === 'paths' && Array.isArray(value)) {
                normalized[normKey] = value
                    .map(v => typeof v === 'string' ? v.replace(/\\/g, '/').replace(/^\.\//, '').trim() : v)
                    .sort(); // Sort arrays alphabetically so order doesn't bypass checks
            } else {
                normalized[normKey] = value;
            }
        }

        // 3. Sort keys of the object alphabetically to ensure consistent stringification
        const sortedKeys = Object.keys(normalized).sort();
        const sortedObj: any = {};
        sortedKeys.forEach(k => {
            sortedObj[k] = normalized[k];
        });

        return sortedObj;
    }

    public hasFailedBefore(toolName: string, params: any): boolean {
        const cleanedTarget = this.cleanParams(params);
        const paramStr = JSON.stringify(cleanedTarget);

        return this.failures.some(f => {
            if (f.toolName !== toolName) return false;
            const cleanedFailure = this.cleanParams(f.parameters);
            return JSON.stringify(cleanedFailure) === paramStr;
        });
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
            MANDATORY: You are now FORBIDDEN from using Python one-liners. You MUST use 'generate_code' to create a script file in '.lollms/scripts/' and then run it.`,

            `### 🛠️ TOOL IMPLEMENTATION ALERT
            The error output indicates a crash in the tool's source code (e.g., TypeError, undefined reference).
            MANDATORY: Do not try to fix the user's project code to solve this. This is a BUG in my own infrastructure.
            STRATEGY: Pivot immediately. Use \`execute_command\` to achieve the same result manually via CLI if the high-level tool is broken.`
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
