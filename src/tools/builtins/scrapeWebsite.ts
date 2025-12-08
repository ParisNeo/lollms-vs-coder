import { ToolDefinition, ToolExecutionEnv } from '../tool';
import fetch from 'node-fetch';

export const scrapeWebsiteTool: ToolDefinition = {
    name: "scrape_website",
    description: "Downloads the content of a website and returns the text. Useful for reading documentation, news articles, or gathering information from search results.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "url", type: "string", description: "The URL of the website to scrape.", required: true }
    ],
    async execute(params: { url: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.url) {
            return { success: false, output: "Error: 'url' parameter is required." };
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
            
            const fetchSignal = signal ?  (anySignal(signal, controller.signal)) : controller.signal;

            const response = await fetch(params.url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                signal: fetchSignal as any
            });
            
            clearTimeout(timeout);

            if (!response.ok) {
                return { success: false, output: `Failed to retrieve content from ${params.url}. Status: ${response.status} ${response.statusText}` };
            }

            const html = await response.text();
            
            // Basic text extraction
            // 1. Remove scripts and styles
            const noScript = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
                                 .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "");
            
            // 2. Remove HTML tags
            let text = noScript.replace(/<[^>]+>/g, " ");
            
            // 3. Decode HTML entities (basic)
            text = text.replace(/&nbsp;/g, " ")
                       .replace(/&amp;/g, "&")
                       .replace(/&lt;/g, "<")
                       .replace(/&gt;/g, ">")
                       .replace(/&quot;/g, '"')
                       .replace(/&#39;/g, "'");

            // 4. Normalize whitespace
            text = text.replace(/\s+/g, " ").trim();

            // 5. Truncate if too long (to save context)
            const maxLength = 12000;
            if (text.length > maxLength) {
                text = text.substring(0, maxLength) + "\n... (Content truncated)";
            }

            if (text.length < 50) {
                 return { success: false, output: `Content too short or failed to parse text from ${params.url}.` };
            }

            return { success: true, output: `Content of ${params.url}:\n\n${text}` };

        } catch (error: any) {
            return { success: false, output: `Error scraping ${params.url}: ${error.message}` };
        }
    }
};

function anySignal(s1: AbortSignal, s2: AbortSignal): AbortSignal {
    if (s1.aborted) return s1;
    if (s2.aborted) return s2;
    const controller = new AbortController();
    const onAbort = () => {
        controller.abort();
        s1.removeEventListener('abort', onAbort);
        s2.removeEventListener('abort', onAbort);
    };
    s1.addEventListener('abort', onAbort);
    s2.addEventListener('abort', onAbort);
    return controller.signal;
}
