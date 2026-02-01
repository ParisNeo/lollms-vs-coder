import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { getProcessedSystemPrompt } from '../../utils';
import { ChatMessage } from '../../lollmsAPI';

async function getCoderSystemPrompt(customPrompt: string, planObjective: string, projectContext: any): Promise<ChatMessage> {
    const agentPersonaPrompt = await getProcessedSystemPrompt('agent', undefined, undefined, undefined, false, projectContext);
    
    const fullContent = `${agentPersonaPrompt}

**CODE GENERATION SPECIFIC INSTRUCTIONS:**
You are a code generation sub-agent. You will be given instructions and context to write or modify a file.

**SKILLS KNOWLEDGE:**
If the context contains a **Skill** (like Moltbook), you MUST treat that documentation as the source of truth for all API calls, parameters, and security rules. Do not hallucinate API endpoints; use the ones from the skills.

**CRITICAL INSTRUCTIONS:**
1.  **CODE ONLY:** Your entire response MUST be a single markdown code block containing the complete file content.
2.  **NO EXTRA TEXT:** Do not add any explanations, comments, or conversational text outside of the code block.
3.  **COMPLETE FILE:** Your output must be the full and complete code for the file, not just the changed parts.
4.  **NO PLACEHOLDERS:** Do not use placeholders like "...".
5.  **NO PATCHES:** You are strictly forbidden from generating git patches or diffs.

**CUSTOM INSTRUCTIONS FOR THIS TASK:**
${customPrompt}

**CONTEXT FOR YOUR TASK:**
- **Main Objective:** ${planObjective}
`;
    
    return {
        role: 'system',
        content: fullContent
    };
}

export const generateCodeTool: ToolDefinition = {
    name: "generate_code",
    description: "Generates code and writes it to a file. Can be used to create new files or overwrite existing ones.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
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

        const currentDiscussion = env.agentManager?.getCurrentDiscussion();
        const modelOverride = currentDiscussion?.model;
        const importedSkills = currentDiscussion?.importedSkills;
        
        let contextData = {
            tree: '',
            files: '',
            skills: ''
        };

        if (env.workspaceRoot) {
            try {
                const allFiles = await env.contextManager.getWorkspaceFilePaths();
                const fileListString = allFiles.join('\n');

                if (allFiles.length > 0) {
                    const selectionSystemPrompt: ChatMessage = {
                        role: 'system',
                        content: `You are a dependency analyzer for file: "${params.file_path}".
Identify which *other* existing files in the project are crucial to read (type definitions, utility functions, signatures, base classes, or CLI structures) to ensure correct implementation.
Select up to 10 relevant files. Return ONLY a valid JSON array of strings. Do NOT select the target file itself.`
                    };

                    const selectionUserPrompt: ChatMessage = {
                        role: 'user',
                        content: `**Target File:** ${params.file_path}\n**Instruction:** ${params.user_prompt}\n**File List:**\n${fileListString}`
                    };

                    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                    const architectModel = config.get<string>('architectModelName') || modelOverride;

                    const selectionResponse = await env.lollmsApi.sendChat([selectionSystemPrompt, selectionUserPrompt], null, signal, architectModel);
                    
                    const jsonMatch = selectionResponse.match(/\[.*\]/s);
                    let selectedFiles: string[] = [];
                    if (jsonMatch) {
                        try {
                            selectedFiles = JSON.parse(jsonMatch[0]);
                        } catch (e) { }
                    }

                    if (selectedFiles.length > 0) {
                        const dependencyContext = await env.contextManager.readSpecificFiles(selectedFiles);
                        if (dependencyContext) {
                            contextData.files += `\n\n==== DYNAMICALLY LOADED DEPENDENCIES ====\n${dependencyContext}\n=========================================\n`;
                        }
                    }
                }
            } catch (e) { }
        }

        const baseContext = await env.contextManager.getContextContent({
            importedSkillIds: importedSkills
        });
        contextData.tree = baseContext.projectTree;
        contextData.files = baseContext.selectedFilesContent + contextData.files; 
        contextData.skills = baseContext.skillsContent;

        let userPromptContent = params.user_prompt || `Generate code for ${params.file_path}`;

        if (env.workspaceRoot) {
            try {
                const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);
                const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                const existingContent = Buffer.from(fileContentBytes).toString('utf8');
                userPromptContent = `I am working on the file \`${params.file_path}\`. Current content:\n\n\`\`\`\n${existingContent}\n\`\`\`\n\nInstruction: ${userPromptContent}`;
            } catch (error) { }
        }

        const coderSystemPrompt = await getCoderSystemPrompt(params.system_prompt || '', env.currentPlan.objective, contextData);
        const coderUserPrompt: ChatMessage = { role: 'user', content: userPromptContent };
        
        const responseText = await env.lollmsApi.sendChat([coderSystemPrompt, coderUserPrompt], null, signal, modelOverride);

        const codeBlockRegex = /```(?:[^\n]*)\n([\s\S]+?)\n```/s;
        const match = responseText.match(codeBlockRegex);
        const generatedCode = match ? match[1].trim() : responseText.trim();

        if (!generatedCode || generatedCode === responseText) {
             const fallbackMatch = responseText.match(/([\s\S]*)/);
             if (fallbackMatch && responseText.includes('import') || responseText.includes('def ')) {
             } else {
                 return { success: false, output: `Coder agent failed to produce a valid code block.` };
             }
        }

        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        try {
            const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);
            const parentUri = vscode.Uri.joinPath(fileUri, '..');
            await vscode.workspace.fs.createDirectory(parentUri);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(generatedCode, 'utf8'));
            return { success: true, output: `Successfully generated and wrote code to file: ${params.file_path}` };
        } catch (error: any) {
            return { success: false, output: `Error writing generated code: ${error.message}` };
        }
    }
};
