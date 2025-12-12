import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const searchWebTool: ToolDefinition = {
    name: "search_web",
    description: "Performs a web search to find solutions, documentation, or code examples. Requires 'Web Search' capability enabled.",
    isAgentic: true,
    isDefault: true,
    hasSettings: true,
    parameters: [
        { name: "query", type: "string", description: "The search query string.", required: true }
    ],
    async execute(params: { query: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        // 1. Transparency Check: Capability (Only if agentManager exists)
        if (env.agentManager) {
            const discussion = env.agentManager.getCurrentDiscussion();
            if (discussion && discussion.capabilities && !discussion.capabilities.webSearch) {
                return { 
                    success: false, 
                    output: "🛑 **Access Denied:** Web Search is disabled for this discussion. To use this feature, please enable 'Web Search' in the Discussion Tools settings (click the gear icon in the chat)." 
                };
            }
        }

        if (!params.query) {
            return { success: false, output: "Error: 'query' parameter is required." };
        }

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const provider = config.get<string>('searchProvider') || 'google_custom_search';
        const apiKey = config.get<string>('searchApiKey');
        const cx = config.get<string>('searchCx');

        // 2. Configuration Check
        if (provider === 'google_custom_search') {
            if (!apiKey || !cx) {
                return { 
                    success: false, 
                    output: "❌ **Configuration Missing:** Google Custom Search is not configured.\n\nPlease go to **Lollms Settings** -> **Tools & Search** and enter your Google Search API Key and Search Engine ID (CX).\nThis allows you to search the web transparently using your own credentials." 
                };
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

                output += `\n**HINT:** Use \`scrape_website\` with one of the links above to read the full content/solution.`;

                // Add the Synthesize button
                const safeQuery = params.query.replace(/"/g, '&quot;');
                output += `\n[command:synthesizeSearchResults|label:Synthesize & Deep Search|params:{"query":"${safeQuery}"}]`;

                return { success: true, output };

            } catch (error: any) {
                return { success: false, output: `Network error during search: ${error.message}` };
            }
        }

        return { success: false, output: `Error: Unsupported search provider '${provider}'.` };
    }
};
