import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { getProcessedSystemPrompt, applySearchReplace } from '../../utils';
import { ChatMessage } from '../../lollmsAPI';

async function getCoderSystemPrompt(
    customPrompt: string, 
    planObjective: string, 
    projectContext: any, 
    fileExists: boolean,
    technicalBriefing: string
): Promise<ChatMessage> {
    const agentPersonaPrompt = await getProcessedSystemPrompt('agent', undefined, undefined, undefined, false, projectContext);
    
    let formatInstructions = "";
    if (fileExists) {
        formatInstructions = `
### ⚡ MODIFICATION MODE: SEARCH/REPLACE (AIDER)
The file already exists. You MUST use the SEARCH/REPLACE block format.

\`\`\`language
<<<<<<< SEARCH
[Exact current lines from the file]
=======
[New lines to replace them with]
>>>>>>> REPLACE
\`\`\`

**STRICT RULES:**
1. **LITERAL MATCH**: The SEARCH block MUST be a character-for-character match of the file content provided in the user prompt.
2. **ZERO DIALOGUE**: Do not explain your changes. Output ONLY the blocks.
3. **NO PLACEHOLDERS**: Provide complete functional code. Never use "// ... rest of code".
`;
    } else {
        formatInstructions = `
### 📄 CREATION MODE: FULL FILE
The file does not exist. You MUST output the **100% COMPLETE** content of the new file.

**STRICT RULES:**
1. **NO SNIPPETS**: Provide every line from start to finish.
2. **ZERO DIALOGUE**: Output ONLY the code block.
`;
    }

    const fullContent = `${agentPersonaPrompt}

# 🎭 ROLE: PRECISION CODE BUILDER
You are a specialized sub-agent tasked with writing or modifying a specific file.

## 🎯 MISSION BRIEFING (YOUR SOURCE OF TRUTH)
The following briefing contains the architectural decisions and discoveries made by the Lead Architect. You MUST follow these instructions over any internal knowledge.

${technicalBriefing || "No specific briefing provided."}

## 🛠️ FORMATTING MANDATE
${formatInstructions}

## 📋 TASK DETAILS
- **Project Objective:** ${planObjective}
- **Specific File Task:** ${customPrompt}

**CRITICAL**: If you include any conversational text, explanations, or "Here is the code", the system will fail. Output ONLY the code blocks.
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
        if (!env.currentPlan) return { success: false, output: "Cannot execute without a plan." };
        if (!params.file_path) return { success: false, output: "Error: 'file_path' parameter is required." };
        
        let filePath = params.file_path.trim().replace(/^[\\\/]+/, '');
        const currentDiscussion = env.agentManager?.getCurrentDiscussion();
        const modelOverride = env.taskModel || currentDiscussion?.model;
        
        // 1. GATHER GROUNDING INFO (BRIEFING + CONTEXT)
        const briefing = env.contextManager.renderBriefing(currentDiscussion);
        
        const discussionSkills = currentDiscussion?.importedSkills || [];
        const taskSkills = env.taskSkills || [];
        const importedSkills = Array.from(new Set([...discussionSkills, ...taskSkills]));
        
        let contextData = { tree: '', files: '', skills: '' };
        
        // Automatically peek at dependencies if the Architect provided them
        if (env.taskFiles && env.taskFiles.length > 0) {
            const depContext = await env.contextManager.readSpecificFiles(env.taskFiles);
            contextData.files = `\n### CRITICAL DEPENDENCIES (Read these first)\n${depContext}\n\n`;
        }

        const baseContext = await env.contextManager.getContextContent({
            importedSkillIds: importedSkills,
            modelName: modelOverride || env.lollmsApi.getModelName(),
            signal
        });
        
        contextData.tree = baseContext.projectTree;
        contextData.files += baseContext.selectedFilesContent;
        contextData.skills = baseContext.skillsContent;

        // 2. PREPARE USER PROMPT WITH FILE CONTENT
        let userPromptContent = params.user_prompt;
        let existingContent: string | null = null;

        if (env.workspaceRoot) {
            try {
                const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, filePath);
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                existingContent = Buffer.from(bytes).toString('utf8');
                userPromptContent = `### TARGET FILE: ${filePath}\n\`\`\`\n${existingContent}\n\`\`\`\n\n### INSTRUCTION\n${userPromptContent}`;
            } catch (error) {
                userPromptContent = `### TARGET FILE: ${filePath} (New File)\n\n### INSTRUCTION\n${userPromptContent}`;
            }
        }

        // 3. CALL BUILDER
        const coderSystemPrompt = await getCoderSystemPrompt(
            params.system_prompt || env.taskPersona || '', 
            env.currentPlan.objective, 
            contextData, 
            !!existingContent,
            briefing
        );
        
        const responseText = await env.lollmsApi.sendChat([
            coderSystemPrompt, 
            { role: 'user', content: userPromptContent }
        ], null, signal, modelOverride);

        // 4. STRICT EXTRACTION (STOPS CONVERSATION FROM LEAKING INTO FILE)
        let finalFileContent = "";
        const cleanResponse = stripThinkingTags(responseText);
        
        // Strategy A: Multi-Hunk Aider
        const aiderRegex = /^<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/gm;
        const matches = [...cleanResponse.matchAll(aiderRegex)];
        
        if (matches.length > 0) {
            if (existingContent) {
                let modified = existingContent;
                for (const match of matches) {
                    const result = applySearchReplace(modified, match[1], match[2]);
                    if (result.success) modified = result.result;
                    else return { success: false, output: `Apply failed: ${result.error}` };
                }
                finalFileContent = modified;
            } else {
                // Fallback for AI using Aider on new files
                finalFileContent = matches.map(m => m[2]).join('\n').trim();
            }
        } else {
            // Strategy B: Full Code Block
            // We search for the first block that doesn't look like a tool call
            const codeBlockRegex = /```(?:\w+)?[\r\n]+([\s\S]*?)[\r\n]+```/g;
            let blockMatch;
            while ((blockMatch = codeBlockRegex.exec(cleanResponse)) !== null) {
                const block = blockMatch[1].trim();
                if (!block.startsWith('{') && block.length > 10) {
                    finalFileContent = block;
                    break;
                }
            }
            
            if (!finalFileContent) {
                // Last ditch: if no blocks but long response, check if it's pure code
                if (cleanResponse.length > 20 && !cleanResponse.includes('I am') && !cleanResponse.includes('Sure!')) {
                    finalFileContent = cleanResponse.trim();
                } else {
                    return { success: false, output: "Error: The builder sub-agent produced conversational text instead of a code block. Task failed." };
                }
            }
        }

        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        try {
            const path = require('path');
            const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, filePath);
            const parentDir = path.dirname(filePath);
            const parentUri = vscode.Uri.joinPath(env.workspaceRoot.uri, parentDir);
            await vscode.workspace.fs.createDirectory(parentUri);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(finalFileContent, 'utf8'));
            
            if (env.contextManager.getContextStateProvider()) {
                await env.contextManager.getContextStateProvider()!.addFilesToContext([filePath]);
            }
            
            return { success: true, output: `Successfully generated and wrote code to file: ${filePath}` };
        } catch (error: any) {
            return { success: false, output: `Error writing generated code: ${error.message}` };
        }
    }
};
