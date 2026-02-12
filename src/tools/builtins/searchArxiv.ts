import { ToolDefinition, ToolExecutionEnv } from '../tool';
import fetch from 'node-fetch';

export const searchArxivTool: ToolDefinition = {
    name: "search_arxiv",
    description: "Searches arXiv for papers. Useful for finding research papers and scientific articles.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "query", type: "string", description: "The search query string.", required: true },
        { name: "max_results", type: "number", description: "Maximum number of results to return (default: 5).", required: false }
    ],
    async execute(params: { query: string, max_results?: number }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.query) {
            return { success: false, output: "Error: 'query' parameter is required." };
        }
        
        const maxResults = params.max_results || 5;
        const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(params.query)}&start=0&max_results=${maxResults}`;

        try {
            const response = await fetch(url, { signal: signal as any });
            if (!response.ok) {
                return { success: false, output: `Arxiv API Error: ${response.status} ${response.statusText}` };
            }
            
            const text = await response.text();
            
            const entries: string[] = [];
            const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
            let match;

            while ((match = entryRegex.exec(text)) !== null) {
                const entryContent = match[1];
                
                const getTag = (tag: string) => {
                    const m = entryContent.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
                    return m ? m[1].trim() : '';
                };

                const title = getTag('title').replace(/\s+/g, ' ').trim();
                const summary = getTag('summary').replace(/\s+/g, ' ').trim();
                const id = getTag('id'); // e.g. http://arxiv.org/abs/2401.00001
                const pdfUrl = id.replace('/abs/', '/pdf/') + ".pdf";
                const published = getTag('published');
                
                const authorRegex = /<author>\s*<name>(.*?)<\/name>\s*<\/author>/g;
                const authors: string[] = [];
                let authorMatch;
                while((authorMatch = authorRegex.exec(entryContent)) !== null) {
                    authors.push(authorMatch[1]);
                }

                entries.push(`**Title:** ${title}\n**ID:** ${id}\n**PDF Link:** ${pdfUrl}\n**Published:** ${published}\n**Authors:** ${authors.join(', ')}\n**Abstract:** ${summary}\n\n*HINT: If you need the full text of this paper, use the \`scrape_website\` tool with the PDF Link.*`);
            }

            if (entries.length === 0) {
                return { success: true, output: "No results found." };
            }

            return { success: true, output: entries.join('\n\n---\n\n') };

        } catch (error: any) {
            return { success: false, output: `Error searching Arxiv: ${error.message}` };
        }
    }
};
