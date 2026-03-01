import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { getProcessedSystemPrompt, applySearchReplace } from '../../utils';
import { ChatMessage } from '../../lollmsAPI';

async function getCoderSystemPrompt(customPrompt: string, planObjective: string, projectContext: any, fileExists: boolean): Promise<ChatMessage> {
    const agentPersonaPrompt = await getProcessedSystemPrompt('agent', undefined, undefined, undefined, false, projectContext);
    
    let formatInstructions = "";
    if (fileExists) {
        formatInstructions = `
**MODIFICATION MODE (AIDER FORMAT):**
The file exists. You MUST use the **SEARCH/REPLACE** block format to edit specific parts of the code.

\`\`\`language
<<<<<<< SEARCH
[Exact code chunk to match from original file]
=======
[New code chunk to replace it with]
>>>>>>> REPLACE
\`\`\`

**RULES FOR SEARCH/REPLACE:**
1. **EXACT MATCH**: The content inside \`SEARCH\` must match the original file exactly (including indentation and whitespace).
2. **CONTEXT**: Include 2-3 lines of unchanged context before and after your changes in the SEARCH block to ensure uniqueness.
3. **MULTIPLE EDITS**: You MUST output multiple small SEARCH/REPLACE blocks in sequence to modify different parts of the file.
4. **GRANULARITY**: Prefer 10 small blocks over 1 large block. If you change two functions, use two separate blocks. If you add imports and change logic, use separate blocks.
5. **NO FULL FILE**: Do NOT output the full file content unless you are rewriting it entirely.
`;
    } else {
        formatInstructions = `
**CREATION MODE:**
The file does not exist. You MUST output the **FULL CONTENT** of the new file in a single markdown code block.
`;
    }

    const fullContent = `${agentPersonaPrompt}

**CODE GENERATION SPECIFIC INSTRUCTIONS:**
You are a code generation sub-agent. You will be given instructions and context to write or modify a file.

**SKILLS KNOWLEDGE (SOURCE OF TRUTH):**
If the context contains an **Active Skill**, you are STRICTLY BOUND by its definitions.
1. **EXACT MATCH**: Use exact method names, parameter types, and return values as documented.
2. **VERIFICATION**: Before outputting an API call for a library mentioned in a skill, verify the syntax against the skill content provided in the context.

**FORMATTING INSTRUCTIONS:**
${formatInstructions}

**CRITICAL INSTRUCTIONS:**
1.  **NO EXTRA TEXT**: Do not add any explanations, comments, or conversational text outside the code block.
2.  **NO PLACEHOLDERS:** Do not use placeholders like "..." inside the code logic.
3.  **NO PATCHES**: Do not use git diff format.

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
        
        // Sanitize path (remove leading slash)
        let filePath = params.file_path.trim();
        if (filePath.startsWith('/') || filePath.startsWith('\\')) {
            filePath = filePath.substring(1);
        }

        const currentDiscussion = env.agentManager?.getCurrentDiscussion();
        const modelOverride = env.taskModel || currentDiscussion?.model;
        
        const discussionSkills = currentDiscussion?.importedSkills ||[];
        const taskSkills = env.taskSkills || [];
        const importedSkills = Array.from(new Set([...discussionSkills, ...taskSkills]));
        
        let contextData = {
            tree: '',
            files: '',
            skills: ''
        };

        if (env.workspaceRoot) {
            try {
                const allFiles = await env.contextManager.getWorkspaceFilePaths();
                const fileListString = allFiles.join('\n');
                
                // If the architect explicitly assigned files, use them immediately
                let selectedFiles: string[] = env.taskFiles ||[];

                // If no explicit files were assigned, fallback to the AI context peek
                if (selectedFiles.length === 0 && allFiles.length > 0) {
                    const selectionSystemPrompt: ChatMessage = {
                        role: 'system',
                        content: `You are a dependency analyzer for file: "${filePath}".
Identify which *other* existing files in the project are crucial to read (type definitions, utility functions, signatures, base classes, or CLI structures) to ensure correct implementation.
Select up to 10 relevant files. Return ONLY a valid JSON array of strings. Do NOT select the target file itself.`
                    };

                    const selectionUserPrompt: ChatMessage = {
                        role: 'user',
                        content: `**Target File:** ${filePath}\n**Instruction:** ${params.user_prompt}\n**File List:**\n${fileListString}`
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
                }

                if (selectedFiles.length > 0) {
                    const dependencyContext = await env.contextManager.readSpecificFiles(selectedFiles);
                    if (dependencyContext) {
                        contextData.files += `\n\n==== ASSIGNED DEPENDENCIES & CONTEXT FILES ====\n${dependencyContext}\n===============================================\n`;
                    }
                }
            } catch (e) { }
        }

        const baseContext = await env.contextManager.getContextContent({
            importedSkillIds: importedSkills,
            modelName: modelOverride || env.lollmsApi.getModelName()
        });
        contextData.tree = baseContext.projectTree;
        contextData.files = baseContext.selectedFilesContent + contextData.files; 
        contextData.skills = baseContext.skillsContent;

        let userPromptContent = params.user_prompt || `Generate code for ${filePath}`;
        let existingContent: string | null = null;

        if (env.workspaceRoot) {
            try {
                const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, filePath);
                const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
                existingContent = Buffer.from(fileContentBytes).toString('utf8');
                userPromptContent = `I am working on the file \`${filePath}\`. Current content:\n\n\`\`\`\n${existingContent}\n\`\`\`\n\nInstruction: ${userPromptContent}`;
            } catch (error) { }
        }

        const coderSystemPrompt = await getCoderSystemPrompt(params.system_prompt || env.taskPersona || '', env.currentPlan.objective, contextData, !!existingContent);
        const coderUserPrompt: ChatMessage = { role: 'user', content: userPromptContent };
        
        const responseText = await env.lollmsApi.sendChat([coderSystemPrompt, coderUserPrompt], null, signal, modelOverride);

        let finalFileContent = "";
        
        // Aider regex (strict start/end)
        const aiderRegex = /^<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/gm;
        const hasAiderBlocks = existingContent && aiderRegex.test(responseText);
        
        if (hasAiderBlocks && existingContent) {
            // Reset regex
            aiderRegex.lastIndex = 0;
            let modifiedContent = existingContent;
            const matches = [...responseText.matchAll(aiderRegex)];
            
            if (matches.length > 0) {
                 for (const match of matches) {
                     const searchBlock = match[1];
                     const replaceBlock = match[2];
                     const result = applySearchReplace(modifiedContent, searchBlock, replaceBlock);
                     if (result.success) {
                         modifiedContent = result.result;
                     } else {
                         return { success: false, output: `Coder agent failed to apply SEARCH/REPLACE block:\n${result.error}\n\nBlock attempted:\n${match[0]}` };
                     }
                 }
                 finalFileContent = modifiedContent;
            } else {
                 finalFileContent = existingContent;
            }
        } else {
            // Fallback to full file extraction
            const codeBlockRegex = /```(?:[^\n]*)\n([\s\S]+?)\n```/s;
            const match = responseText.match(codeBlockRegex);
            const generatedCode = match ? match[1].trim() : responseText.trim();
            
            if (!generatedCode || (generatedCode === responseText && !responseText.includes('def ') && !responseText.includes('class ') && !responseText.includes('import '))) {
                 return { success: false, output: `Coder agent failed to produce a valid code block.` };
            }
            finalFileContent = generatedCode;
        }

        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        try {
            const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, filePath);
            const parentUri = vscode.Uri.joinPath(fileUri, '..');
            await vscode.workspace.fs.createDirectory(parentUri);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(finalFileContent, 'utf8'));
            return { success: true, output: `Successfully generated and wrote code to file: ${filePath}` };
        } catch (error: any) {
            return { success: false, output: `Error writing generated code: ${error.message}` };
        }
    }
};
