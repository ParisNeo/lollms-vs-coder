import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { getProcessedSystemPrompt } from '../../utils';
import { ChatMessage } from '../../lollmsAPI';

function getCoderSystemPrompt(customPrompt: string, planObjective: string, projectContext: string): ChatMessage {
    const agentPersonaPrompt = getProcessedSystemPrompt('agent');
    return {
        role: 'system',
        content: `You are a code generation AI. You will be given instructions and context to write or modify a file.
**CRITICAL INSTRUCTIONS:**
1.  **CODE ONLY:** Your entire response MUST be a single markdown code block containing the complete file content.
2.  **NO EXTRA TEXT:** Do not add any explanations, comments, or conversational text outside of the code block.
3.  **COMPLETE FILE:** Your output must be the full and complete code for the file, not just the changed parts.
4.  **NO PLACEHOLDERS:** Do not use placeholders like "...".
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

        const projectContext = await env.contextManager.getContextContent();
        let userPromptContent = params.user_prompt || `Generate code for ${params.file_path}`;
        const modelOverride = env.agentManager.getCurrentDiscussion()?.model;

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

        const coderSystemPrompt = getCoderSystemPrompt(params.system_prompt || '', env.currentPlan.objective, projectContext.text);
        const coderUserPrompt: ChatMessage = { role: 'user', content: userPromptContent };
        const responseText = await env.lollmsApi.sendChat([coderSystemPrompt, coderUserPrompt], null, signal, modelOverride);

        const codeBlockRegex = /```(?:[\w-]*)\n([\s\S]+?)\n```/s;
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
