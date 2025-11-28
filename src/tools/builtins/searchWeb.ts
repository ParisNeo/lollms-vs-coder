import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const searchWebTool: ToolDefinition = {
    name: "search_web",
    description: "Performs a web search to retrieve information, documentation, or solutions from the internet (e.g., StackOverflow, libraries).",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "query", type: "string", description: "The search query string.", required: true }
    ],
    async execute(params: { query: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.query) {
            return { success: false, output: "Error: 'query' parameter is required." };
        }

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const provider = config.get<string>('searchProvider') || 'google_custom_search';
        const apiKey = config.get<string>('searchApiKey');
        const cx = config.get<string>('searchCx'); // Search Engine ID

        if (provider === 'google_custom_search') {
            if (!apiKey || !cx) {
                return { success: false, output: "Error: Google Custom Search requires 'searchApiKey' and 'searchCx' to be configured in extension settings." };
            }

            try {
                const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(params.query)}`;
                const response = await fetch(url, { signal: signal as any });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    return { success: false, output: `Google Search API Error: ${response.status} ${response.statusText} - ${errorText}` };
                }

                const data = await response.json();
                
                if (!data.items || data.items.length === 0) {
                    return { success: true, output: "No results found." };
                }

                let output = `Search Results for "${params.query}":\n\n`;
                data.items.slice(0, 5).forEach((item: any, index: number) => {
                    output += `${index + 1}. **${item.title}**\n   ${item.snippet}\n   [Link](${item.link})\n\n`;
                });

                return { success: true, output };

            } catch (error: any) {
                return { success: false, output: `Network error during search: ${error.message}` };
            }
        }

        return { success: false, output: `Error: Unsupported search provider '${provider}'.` };
    }
};
