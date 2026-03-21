export interface ResponseProfile {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    prefix?: string;
}

export const SYSTEM_RESPONSE_PROFILES: ResponseProfile[] = [
    {
        id: "balanced",
        name: "Balanced (Default)",
        description: "Natural technical flow: Brief explanation followed by implementation.",
        systemPrompt: "### RESPONSE STYLE: BALANCED\n- **Logic**: Briefly explain the technical approach or reasoning behind your solution.\n- **Implementation**: Provide the code or perform the actions immediately after the explanation.\n- **Tone**: Professional, helpful, and direct.",
        prefix: ""
    },
    {
        id: "structured",
        name: "Structured (Analytical)",
        description: "Formal Problem/Hypothesis/Fix breakdown.",
        systemPrompt: "### RESPONSE STYLE: STRUCTURED\n- **MANDATORY LAYOUT**: You MUST follow this three-part structure for every response:\n  1. **Problem**: Identify what is being asked or what issue was found.\n  2. **Hypothesis**: Describe the technical path chosen and why.\n  3. **Fix**: Provide the actual implementation or code.",
        prefix: ""
    },
    {
        id: "minimalist",
        name: "Minimalist",
        description: "Just the answer/code. Zero fluff.",
        systemPrompt: "### RESPONSE STYLE: MINIMALIST\n- **Directness**: Do not include introductions, conclusions, or 'Here is your code'.\n- **Content**: Provide only the requested code block or the direct answer to the question.\n- **Brevity**: Extreme conciseness.",
        prefix: ""
    }
];