// File: src/tools/builtins/searchStackOverflow.ts

import { ToolDefinition, ToolExecutionEnv } from '../tool';
import fetch from 'node-fetch';

export const searchStackOverflowTool: ToolDefinition = {
    name: "search_stackoverflow",
    description: "Searches Stack Overflow for programming help, bug fixes, and code examples.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'internet_access',
    parameters: [
        { name: "query", type: "string", description: "The technical question or error message.", required: true },
        { name: "tags", type: "string", description: "Optional tags to narrow search (e.g., 'python;pandas').", required: false }
    ],
    async execute(params: { query: string, tags?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const tags = params.tags ? `&tagged=${encodeURIComponent(params.tags)}` : '';
        const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(params.query)}${tags}&site=stackoverflow`;

        try {
            const response = await fetch(url, { signal: signal as any });
            const data: any = await response.json();

            if (!data.items || data.items.length === 0) {
                return { success: true, output: "No relevant Stack Overflow discussions found." };
            }

            let output = `Top Stack Overflow results for "${params.query}":\n\n`;
            data.items.slice(0, 3).forEach((item: any, i: number) => {
                output += `${i + 1}. **${item.title}**\n   Score: ${item.score} | Status: ${item.is_answered ? '✅ Answered' : '⏳ Unanswered'}\n   [View Discussion](${item.link})\n\n`;
            });

            output += `\n**HINT:** Use \`scrape_website\` with one of these links to read the accepted answer.`;
            return { success: true, output };

        } catch (e: any) {
            return { success: false, output: `Stack Overflow search failed: ${e.message}` };
        }
    }
};
