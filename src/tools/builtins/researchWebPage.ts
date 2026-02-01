import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const researchWebPageTool: ToolDefinition = {
    name: "research_web_page",
    description: "Scrapes a web page, extracts information relevant to a specific objective using AI, and saves the findings to the project research notes.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'internet_access',
    parameters: [
        { name: "url", type: "string", description: "The URL of the web page to research.", required: true },
        { name: "research_objective", type: "string", description: "What specific information are you looking for? (e.g., 'API documentation for login', 'Current version of library X')", required: true }
    ],
    async execute(params: { url: string, research_objective: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.url || !params.research_objective) {
            return { success: false, output: "Error: Both 'url' and 'research_objective' are required." };
        }

        try {
            // 1. Scrape the raw content
            const response = await fetch(params.url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Lollms Research Agent)' },
                signal: signal as any
            });

            if (!response.ok) {
                return { success: false, output: `Failed to fetch ${params.url}: ${response.status} ${response.statusText}` };
            }

            const html = await response.text();
            
            // Basic cleaning
            const cleanText = html
                .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
                .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim();

            const truncatedText = cleanText.substring(0, 15000); // Limit to 15k chars for extraction step

            // 2. Use LLM to extract relevant info
            const extractionPrompt = `You are a Research Assistant. 
I have scraped a web page: ${params.url}
My research objective is: "${params.research_objective}"

Below is the text content of the page. Please extract ONLY the information relevant to the objective. 
- Be concise and factual. 
- Use bullet points.
- If the information is not found, state "No relevant information found."
- Do not add conversational filler.

CONTENT:
${truncatedText}`;

            const extractedInfo = await env.lollmsApi.sendChat([
                { role: 'system', content: "You are a precise information extraction engine." },
                { role: 'user', content: extractionPrompt }
            ], null, signal);

            if (extractedInfo.includes("No relevant information found") && extractedInfo.length < 50) {
                return { success: true, output: `Research completed for ${params.url}. No information matching the objective was found.` };
            }

            // 3. Persist the information
            if (env.workspaceRoot) {
                const notesUri = vscode.Uri.joinPath(env.workspaceRoot.uri, '.lollms', 'research_notes.md');
                const timestamp = new Date().toLocaleString();
                const newNote = `\n## Research: ${params.url}\n**Objective:** ${params.research_objective}\n**Date:** ${timestamp}\n\n${extractedInfo}\n\n---`;
                
                let existingContent = Buffer.from("");
                try {
                    existingContent = await vscode.workspace.fs.readFile(notesUri);
                } catch (e) {
                    // File doesn't exist, will create
                }

                const updatedContent = Buffer.concat([existingContent, Buffer.from(newNote, 'utf8')]);
                await vscode.workspace.fs.writeFile(notesUri, updatedContent);
            }

            return { 
                success: true, 
                output: `Successfully researched ${params.url}. Relevant information extracted and saved to research notes:\n\n${extractedInfo}` 
            };

        } catch (error: any) {
            return { success: false, output: `Research failed: ${error.message}` };
        }
    }
};
