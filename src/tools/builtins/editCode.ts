import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { applySearchReplace, getProcessedSystemPrompt, stripThinkingTags } from '../../utils';
import { ChatMessage } from '../../lollmsAPI';

/**
 * Enhanced System Prompt for the Editor sub-agent.
 * Similar to generateCode but specialized for surgical modification.
 */
async function getEditorSystemPrompt(
    customPrompt: string, 
    planObjective: string, 
    projectContext: any, 
    briefing: string
): Promise<ChatMessage> {
    const agentPersonaPrompt = await getProcessedSystemPrompt('agent', undefined, undefined, undefined, false, projectContext);
    
    const fullContent = `${agentPersonaPrompt}

# 🎭 ROLE: PRECISION CODE EDITOR
You are a specialized sub-agent tasked with surgically modifying an existing file.

## 🎯 MISSION BRIEFING (YOUR SOURCE OF TRUTH)
The following briefing contains the architectural decisions and discoveries made by the Lead Architect. You MUST follow these instructions over any internal knowledge.

${briefing || "No specific briefing provided."}

## 🛠️ FORMATTING MANDATE: SEARCH/REPLACE (AIDER)
You MUST output your changes using the SEARCH/REPLACE block format. 

\`\`\`language
<<<<<<< SEARCH
[Exact current lines from the file]
=======
[New lines to replace them with]
>>>>>>> REPLACE
\`\`\`

**STRICT RULES:**
1. **LITERAL MATCH**: The SEARCH block MUST be a character-for-character match of the existing code provided in the user prompt, including all indentation and blank lines.
2. **UNIQUE CONTEXT**: Include 3-4 lines of unchanged context in the SEARCH block to ensure a unique match.
3. **ZERO DIALOGUE**: Do not explain your changes. Output ONLY the blocks.
4. **NO PLACEHOLDERS**: Provide complete functional code. Never use "// ... rest of code".

## 📋 TASK DETAILS
- **Project Objective:** ${planObjective}
- **Specific File Task:** ${customPrompt}

**CRITICAL**: If you include any conversational text, explanations, or "Here is the code", the system will fail. Output ONLY the SEARCH/REPLACE blocks.
`;
    
    return {
        role: 'system',
        content: fullContent
    };
}

export const editCodeTool: ToolDefinition = {
    name: "edit_code",
    description: "Edits an existing file. Applies changes using the Aider SEARCH/REPLACE format. This is the preferred tool for surgical modifications.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters:[
        { name: "file_path", type: "string", description: "The relative path of the file to edit.", required: true },
        { name: "instructions", type: "string", description: "Detailed instructions on what to change.", required: true }
    ],
    async execute(params: { file_path: string, instructions: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot || !env.currentPlan) return { success: false, output: "Error: Workspace root or active plan missing." };
        
        let filePath = params.file_path.trim().replace(/^[\\\/]+/, '');
        const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, filePath);
        
        let originalContent = "";
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            originalContent = Buffer.from(bytes).toString('utf8');
        } catch (e) {
            return { success: false, output: `File not found: ${filePath}. Use 'generate_code' to create new files.` };
        }

        const currentDiscussion = env.agentManager?.getCurrentDiscussion();
        const modelOverride = env.taskModel || currentDiscussion?.model;
        
        // 1. GATHER GROUNDING INFO
        const briefing = env.contextManager.renderBriefing(currentDiscussion);
        
        const discussionSkills = currentDiscussion?.importedSkills || [];
        const taskSkills = env.taskSkills || [];
        const importedSkills = Array.from(new Set([...discussionSkills, ...taskSkills]));
        
        let contextData = { tree: '', files: '', skills: '' };
        
        // Peek at dependencies assigned by Architect
        if (env.taskFiles && env.taskFiles.length > 0) {
            const depContext = await env.contextManager.readSpecificFiles(env.taskFiles);
            contextData.files = `\n### CRITICAL DEPENDENCIES\n${depContext}\n\n`;
        }

        const baseContext = await env.contextManager.getContextContent({
            importedSkillIds: importedSkills,
            modelName: modelOverride || env.lollmsApi.getModelName(),
            signal
        });
        
        contextData.tree = baseContext.projectTree;
        contextData.files += baseContext.selectedFilesContent;
        contextData.skills = baseContext.skillsContent;

        // 2. CALL EDITOR SUB-AGENT
        const systemPrompt = await getEditorSystemPrompt(
            params.instructions, 
            env.currentPlan.objective, 
            contextData, 
            briefing
        );

        const userPrompt = `### TARGET FILE: ${filePath}\n\`\`\`\n${originalContent}\n\`\`\`\n\n### INSTRUCTION\n${params.instructions}`;

        const response = await env.lollmsApi.sendChat([
            systemPrompt,
            { role: 'user', content: userPrompt }
        ], null, signal, modelOverride);

        // 3. STRICT EXTRACTION & APPLICATION
        const cleanResponse = stripThinkingTags(response);
        const aiderRegex = /^<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/gm;
        const matches = [...cleanResponse.matchAll(aiderRegex)];

        if (matches.length === 0) {
            return { success: false, output: `Error: The editor sub-agent produced conversational text or invalid Aider blocks instead of SEARCH/REPLACE modifications. Response was:\n${cleanResponse.substring(0, 500)}...` };
        }

        let workingContent = originalContent;
        let appliedCount = 0;
        let errors: string[] = [];
        
        for (const match of matches) {
            const result = applySearchReplace(workingContent, match[1], match[2]);
            if (result.success) {
                workingContent = result.result;
                appliedCount++;
            } else {
                errors.push(result.error || "Unknown match error");
            }
        }

        if (appliedCount > 0) {
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(workingContent, 'utf8'));
            
            let output = `Successfully applied ${appliedCount} surgical edits to \`${filePath}\`.`;
            if (errors.length > 0) {
                output += `\n\n⚠️ **WARNING**: ${errors.length} blocks failed to apply:\n- ${errors.join('\n- ')}`;
            }
            return { success: true, output };
        } else {
            return { success: false, output: `Match Failure: None of the provided SEARCH blocks matched the file content. Ensure your search blocks are identical to the source code.\nErrors:\n- ${errors.join('\n- ')}` };
        }
    }
};