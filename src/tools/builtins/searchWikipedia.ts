// File: src/tools/builtins/searchWikipedia.ts

import { ToolDefinition, ToolExecutionEnv } from '../tool';
import fetch from 'node-fetch';

export const searchWikipediaTool: ToolDefinition = {
    name: "search_wikipedia",
    description: "Searches Wikipedia for general knowledge, biographies, history, and concepts. Returns a summary and a link to the full article.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'internet_access',
    parameters: [
        { name: "query", type: "string", description: "The search term or concept to look up.", required: true }
    ],
    async execute(params: { query: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.query) return { success: false, output: "Error: Query is required." };

        const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(params.query.replace(/ /g, '_'))}`;

        try {
            const response = await fetch(url, { 
                headers: { 'User-Agent': 'Lollms-VS-Coder/1.0 (https://github.com/parisneo/lollms-vs-coder)' },
                signal: signal as any 
            });

            if (response.status === 404) {
                // Try a search instead of a direct summary if not found
                const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(params.query)}&format=json&origin=*`;
                const searchRes = await fetch(searchUrl, { signal: signal as any });
                const searchData: any = await searchRes.json();
                
                if (searchData.query?.search?.length > 0) {
                    const bestMatch = searchData.query.search[0].title;
                    return this.execute({ query: bestMatch }, env, signal);
                }
                return { success: true, output: `No Wikipedia article found for "${params.query}".` };
            }

            if (!response.ok) throw new Error(`Wikipedia API error: ${response.status}`);

            const data: any = await response.json();
            const output = `**Wikipedia: ${data.title}**\n\n${data.extract}\n\n[Read More](${data.content_urls.desktop.page})`;
            
            return { success: true, output };

        } catch (e: any) {
            return { success: false, output: `Wikipedia search failed: ${e.message}` };
        }
    }
};
