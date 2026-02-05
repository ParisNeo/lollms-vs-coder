import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const summarizeTextTool: ToolDefinition = {
    name: "summarize_text",
    description: "Summarizes text content. Handles long texts by splitting them into chunks (Map-Reduce strategy).",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "text", type: "string", description: "The text to summarize.", required: true },
        { name: "objective", type: "string", description: "The goal/focus of the summary.", required: false },
        { name: "detail_level", type: "string", description: "brief, detailed, or bullets", required: false }
    ],
    async execute(params: { text: string, objective?: string, detail_level?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.text) {
            return { success: false, output: "Error: 'text' is required." };
        }

        const objective = params.objective || "General summary";
        const detail = params.detail_level || "detailed";
        
        // Chunk size: approx 12k chars (~3-4k tokens) to be safe for most models context windows
        const CHUNK_SIZE = 12000;
        
        if (params.text.length <= CHUNK_SIZE) {
            // Simple case: Short text
            return await generateSummary(params.text, objective, detail, env, signal);
        }

        // --- Long Text Strategy: Map-Reduce ---
        
        // 1. Split into chunks
        const chunks: string[] = [];
        for (let i = 0; i < params.text.length; i += CHUNK_SIZE) {
            chunks.push(params.text.substring(i, i + CHUNK_SIZE));
        }

        // 2. Map: Summarize each chunk
        const partialSummaries: string[] = [];
        
        // Process sequentially to avoid overloading local API or hitting rate limits
        for (let i = 0; i < chunks.length; i++) {
            if (signal.aborted) throw new Error("Summarization aborted");
            
            // Inform context if possible (optional logging)
            // console.log(`Summarizing chunk ${i+1}/${chunks.length}...`);
            
            const chunkObjective = `Summarize this part of a larger text. Focus on: ${objective}. Keep it concise to be combined later.`;
            const result = await generateSummary(chunks[i], chunkObjective, "brief", env, signal);
            
            if (result.success) {
                partialSummaries.push(result.output);
            }
        }

        // 3. Reduce: Summarize the combined summaries
        const combinedText = partialSummaries.join("\n\n=== NEXT SECTION ===\n\n");
        const finalObjective = `Create a coherent final summary from these partial notes. Original Objective: ${objective}`;
        
        return await generateSummary(combinedText, finalObjective, detail, env, signal);
    }
};

async function generateSummary(text: string, objective: string, detail: string, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean, output: string }> {
    const systemPrompt = `You are an expert Summarizer.
Objective: ${objective}
Detail Level: ${detail}

Instructions:
- Capture the main ideas accurately.
- Use markdown formatting.
- If the text is a transcript, ignore timestamp artifacts or stuttering.`;

    const userPrompt = `Text to summarize:\n\n${text}`;

    try {
        const response = await env.lollmsApi.sendChat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ], null, signal);

        return { success: true, output: response };
    } catch (e: any) {
        return { success: false, output: `Summarization failed: ${e.message}` };
    }
}
