import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const searchKeywordsTool: ToolDefinition = {
    name: "search_keywords",
    description: "Fast project-wide keyword search. Scans all files in the workspace for literal matches. Best for finding where a specific variable, function name, or error code is used.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "keywords", type: "array", description: "List of strings to search for.", required: true },
        { name: "include_paths", type: "string", description: "Optional: Glob pattern to limit search (e.g. 'src/**/*.ts').", required: false }
    ],
    async execute(params: { keywords: string[], include_paths?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "No workspace." };

        const results: string[] = [];
        const maxResultsPerKeyword = 5;

        for (const kw of params.keywords) {
            if (signal.aborted) break;
            
            // We use VS Code's findTextInFiles for maximum performance (uses ripgrep internally)
            await vscode.workspace.findTextInFiles(
                { pattern: kw, isCaseSensitive: false, isWordMatch: true },
                { include: params.include_paths, previewOptions: { charsPerLine: 100, matchedRelevantLines: 1 } },
                (result) => {
                    if (results.length < 50) { // Global cap
                        const relPath = vscode.workspace.asRelativePath(result.uri);
                        results.push(`[${relPath}] Line ${result.ranges[0].start.line + 1}: ${result.preview.text.trim()}`);
                    }
                }
            );
        }

        return { 
            success: true, 
            output: results.length > 0 ? results.join('\n') : "No matches found for these keywords." 
        };
    }
};
