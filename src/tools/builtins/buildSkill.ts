import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const buildSkillTool: ToolDefinition = {
    name: "build_skill",
    description: "Creates and saves a new skill with a name, description, and content.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "name", type: "string", description: "The name of the skill.", required: true },
        { name: "description", type: "string", description: "Description of what the skill does.", required: true },
        { name: "content", type: "string", description: "The code or text content of the skill.", required: true },
        { name: "language", type: "string", description: "The language of the content (e.g., 'python', 'javascript'). Defaults to 'markdown'.", required: false }
    ],
    async execute(params: { name: string, description: string, content: string, language?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.skillsManager) {
            return { success: false, output: "Error: SkillsManager not available." };
        }
        
        await env.skillsManager.addSkill({
            name: params.name,
            description: params.description,
            content: params.content,
            language: params.language || 'markdown'
        });

        // We return the content in a skill block so the UI renders the 'Save Skill' button,
        // confirming it was recognized as a skill (even if already saved).
        return { 
            success: true, 
            output: `Skill '${params.name}' saved successfully.\n\n\`\`\`skill\n${params.content}\n\`\`\`` 
        };
    }
};
