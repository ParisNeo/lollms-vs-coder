import { ToolDefinition, ToolExecutionEnv } from '../tool';
import fetch from 'node-fetch';
import { stripThinkingTags } from '../../utils';

export const webDiveTool: ToolDefinition = {
    name: "web_dive",
    description: "Phase 2 of Research: Deeply reads specific URLs found during search. Scrapes the full text and uses AI to extract exact technical details (commands, versions, configs).",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'internet_access',
    parameters: [
        { name: "urls", type: "array", description: "List of URLs to dive into.", required: true },
        { name: "objective", type: "string", description: "What specific technical info are you looking for inside these pages?", required: true }
    ],
    async execute(params: { urls: string[], objective: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const results: string[] = [];
        
        for (const url of params.urls.slice(0, 3)) { // Limit to top 3 for context safety
            try {
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: signal as any });
                if (!res.ok) continue;
                const html = await res.text();
                const cleanText = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "").replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "").replace(/<[^>]+>/g, " ").substring(0, 25000);

                const distillationPrompt = `You are a Technical Data Extractor. 
Objective: "${params.objective}"
Source: ${url}

Extract ONLY the specific technical details (CLI commands, file paths, version numbers, or exact steps) needed to fulfill the objective. 
If the page doesn't contain the info, say "NOT_FOUND".
Output format: Bullet points.`;

                const distilled = await env.lollmsApi.sendChat([
                    { role: 'system', content: distillationPrompt },
                    { role: 'user', content: cleanText }
                ], null, signal);
                
                results.push(`### Source: ${url}\n${distilled}`);
            } catch (e) {
                results.push(`### Source: ${url}\nError: Failed to reach site.`);
            }
        }

        return { success: true, output: results.join('\n\n---\n\n') };
    }
};