import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { getProcessedSystemPrompt } from '../../utils';
import { ChatMessage } from '../../lollmsAPI';

async function getCoderSystemPrompt(customPrompt: string, planObjective: string, projectContext: string): Promise<ChatMessage> {
    const agentPersonaPrompt = await getProcessedSystemPrompt('agent');
    return {
        role: 'system',
        content: `You are a code generation AI. You will be given instructions and context to write or modify a file.
**CRITICAL INSTRUCTIONS:**
1.  **CODE ONLY:** Your entire response MUST be a single markdown code block containing the complete file content.
2.  **NO EXTRA TEXT:** Do not add any explanations, comments, or conversational text outside of the code block.
3.  **COMPLETE FILE:** Your output must be the full and complete code for the file, not just the changed parts.
4.  **NO PLACEHOLDERS:** Do not use placeholders like "...".
5.  **NO PATCHES:** You are strictly forbidden from generating git patches, unified diffs, or using formats like \`--- a/file\`. You must output the full file content using the standard markdown block format (\`\`\`language\\ncontent\\n\`\`\`).
**CUSTOM INSTRUCTIONS FOR THIS TASK:**
${customPrompt}
**CONTEXT FOR YOUR TASK:**
- **Main Objective:** ${planObjective}
- **Project Structure & Context:**
${projectContext}

**Agent Persona:**
${agentPersonaPrompt}
`
    };
}

export const generateCodeTool: ToolDefinition = {
    name: "generate_code",
    description: "Generates code and writes it to a file. Can be used to create new files or overwrite existing ones.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "file_path", type: "string", description: "The relative path of the file to create or overwrite.", required: true },
        { name: "user_prompt", type: "string", description: "The detailed instructions for what code to generate.", required: true },
        { name: "system_prompt", type: "string", description: "Optional system prompt to guide the sub-agent's persona and style.", required: false }
    ],
    async execute(params: { file_path: string, user_prompt: string, system_prompt?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.currentPlan) {
            return { success: false, output: "Cannot execute without a plan." };
        }
        if (!params.file_path) {
            return { success: false, output: "Error: 'file_path' parameter is required." };
        }

        const modelOverride = env.agentManager?.getCurrentDiscussion()?.model;
        let projectContextText = "";

        // --- STEP 1: DYNAMIC CONTEXT RETRIEVAL (Anti-Hallucination) ---
        // Before generating code, ask the AI which OTHER files in the workspace are relevant.
        if (env.workspaceRoot) {
            try {
                // 1. Get the list of all available files
                const allFiles = await env.contextManager.getWorkspaceFilePaths();
                const fileListString = allFiles.join('\n');

                if (allFiles.length > 0) {
                    // 2. Ask the AI to pick relevant files (Pre-check to prevent hallucinations)
                    const selectionSystemPrompt: ChatMessage = {
                        role: 'system',
                        content: `You are a dependency analyzer. You are about to write code for the file: "${params.file_path}".
Your task is to identify which *other* existing files in the project are crucial to read (e.g., for type definitions, utility functions, signatures, or base classes) to ensure the new code is correct and DOES NOT HALLUCINATE functions.

**INSTRUCTIONS:**
1. Review the provided file list.
2. Select up to 10 most relevant files that you need to read to get signatures and definitions.
3. Return ONLY a valid JSON array of strings containing the relative paths.
4. Do NOT select the target file "${params.file_path}" itself (we will read it separately).
5. If no other files are needed, return an empty JSON array [].

Example Output:
["src/types.ts", "src/utils/helpers.ts"]`
                    };

                    const selectionUserPrompt: ChatMessage = {
                        role: 'user',
                        content: `**Target File to Write:** ${params.file_path}\n\n**User Instruction:** ${params.user_prompt}\n\n**Project File List:**\n${fileListString}`
                    };

                    // Use the architect model if available for better reasoning on dependencies
                    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                    const architectModel = config.get<string>('architectModelName') || modelOverride;

                    const selectionResponse = await env.lollmsApi.sendChat([selectionSystemPrompt, selectionUserPrompt], null, signal, architectModel);
                    
                    // 3. Parse JSON response
                    const jsonMatch = selectionResponse.match(/\[.*\]/s);
                    let selectedFiles: string[] = [];
                    if (jsonMatch) {
                        try {
                            selectedFiles = JSON.parse(jsonMatch[0]);
                        } catch (e) { console.error("Error parsing dependency selection JSON", e); }
                    }

                    // 4. Read content of selected files
                    if (selectedFiles.length > 0) {
                        const dependencyContext = await env.contextManager.readSpecificFiles(selectedFiles);
                        if (dependencyContext) {
                            projectContextText += `\n\n==== DYNAMICALLY LOADED DEPENDENCIES (READ THESE FOR SIGNATURES) ====\nThe following files were identified as relevant dependencies. Use their definitions to avoid hallucinating functions:\n\n${dependencyContext}\n=========================================\n`;
                        }
                    }
                }
            } catch (e) {
                console.error("Dynamic context retrieval failed:", e);
                // Continue without dynamic context if this fails
            }
        }

        // --- STEP 2: PREPARE MAIN PROMPT ---
        const baseContext = await env.contextManager.getContextContent();
        projectContextText += baseContext.text;

        let userPromptContent = params.user_prompt || `Generate code for ${params.file_path}`;

        if (env.workspaceRoot) {
            try {
                const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);
                const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                const existingContent = Buffer.from(fileContentBytes).toString('utf8');
                userPromptContent = `I am working on the file \`${params.file_path}\`. Here is its current content:\n\n\`\`\`\n${existingContent}\n\`\`\`\n\nMy instruction is: ${userPromptContent}`;
            } catch (error) {
                // File doesn't exist, which is fine for creation.
            }
        }

        const coderSystemPrompt = await getCoderSystemPrompt(params.system_prompt || '', env.currentPlan.objective, projectContextText);
        const coderUserPrompt: ChatMessage = { role: 'user', content: userPromptContent };
        
        // --- STEP 3: GENERATE CODE ---
        const responseText = await env.lollmsApi.sendChat([coderSystemPrompt, coderUserPrompt], null, signal, modelOverride);

        // Updated regex to support `language:path` header syntax
        const codeBlockRegex = /```(?:[^\n]*)\n([\s\S]+?)\n```/s;
        const match = responseText.match(codeBlockRegex);
        const generatedCode = match ? match[1].trim() : responseText.trim();

        if (!generatedCode) {
            return { success: false, output: `Coder agent failed to produce any valid code. Full response:\n${responseText}` };
        }

        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder to write the file." };
        }

        try {
            const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);
            const parentUri = vscode.Uri.joinPath(fileUri, '..');
            await vscode.workspace.fs.createDirectory(parentUri);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(generatedCode, 'utf8'));
            return { success: true, output: `Successfully generated and wrote code to file: ${params.file_path}` };
        } catch (error: any) {
            return { success: false, output: `Error writing generated code to file ${params.file_path}: ${error.message}` };
        }
    }
};
