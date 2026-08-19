import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { Skill } from '../../skillsManager';

export const buildSkillTool: ToolDefinition = {
    name: "build_skill",
    description: "Creates a new skill or updates an existing skill from learned experience/lessons, and automatically binds it to the active discussion context.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "name", type: "string", description: "Clear, descriptive title for the skill (e.g. 'FastAPI Security & Validation Patterns').", required: true },
        { name: "description", type: "string", description: "One-sentence summary of what this skill teaches and when to apply it.", required: true },
        { name: "content", type: "string", description: "The full technical instructions, guidelines, code patterns, or constraints that constitute the skill.", required: true },
        { name: "skill_id", type: "string", description: "Optional ID of an existing skill to update with new learnings. If omitted, matches by name or creates a new ID.", required: false },
        { name: "category", type: "string", description: "Category path (e.g., 'patterns/api', 'debugging', 'architecture', 'lessons_learned'). Defaults to 'lessons_learned'.", required: false },
        { name: "scope", type: "string", description: "'local' for this project only or 'global' for all future projects across VS Code. Defaults to 'local'.", required: false },
        { name: "language", type: "string", description: "Format/language of the content (e.g. 'markdown', 'typescript', 'python'). Defaults to 'markdown'.", required: false },
        { name: "add_to_context", type: "boolean", description: "Whether to immediately activate and attach this skill to the current chat/agent context. Defaults to true.", required: false }
    ],
    async execute(
        params: { 
            name?: string; 
            description?: string; 
            content?: string; 
            skill_id?: string;
            category?: string; 
            scope?: 'global' | 'local'; 
            language?: string;
            add_to_context?: boolean;
        }, 
        env: ToolExecutionEnv, 
        signal?: AbortSignal
    ): Promise<{ success: boolean; output: string; }> {
        const skillsManager = env.skillsManager || (env.contextManager as any)?.skillsManager || (env.agentManager as any)?.skillsManager;
        if (!skillsManager) {
            return { success: false, output: "Error: SkillsManager is not available in current execution environment." };
        }

        // Defensive parameter extraction supporting all common LLM variations
        const rawName = params.name || (params as any).skill_name || (params as any).title || (params as any).skillName || (params as any).id || (params as any).skill_id || "unnamed_skill";
        const name = String(rawName).trim();

        const rawDesc = params.description || (params as any).desc || (params as any).summary || (params as any).about || `Skill for ${name}`;
        const description = String(rawDesc).trim();

        const rawContent = params.content || (params as any).body || (params as any).text || (params as any).code || (params as any).instructions || (params as any).markdown || "";
        const content = String(rawContent).trim();

        const rawSkillId = params.skill_id || (params as any).skillId || (params as any).id;
        const skillId = rawSkillId ? String(rawSkillId).trim() : undefined;

        const rawCategory = params.category || (params as any).cat || (params as any).category_path || (params as any).group || 'lessons_learned';
        const category = String(rawCategory).trim();

        const rawScope = params.scope || (params as any).target_scope || (params as any).visibility;
        const scope: 'global' | 'local' = String(rawScope).toLowerCase() === 'global' ? 'global' : 'local';

        const rawLanguage = params.language || (params as any).lang || 'markdown';
        const language = String(rawLanguage).trim();

        const shouldAddToContext = params.add_to_context !== false && (params as any).addToContext !== false;

        const allSkills = await skillsManager.getSkills();

        // Check if updating an existing skill by ID or by exact/normalized name
        let targetSkill: Skill | undefined;
        if (skillId) {
            targetSkill = allSkills.find(s => s.id === skillId);
        }
        if (!targetSkill && name) {
            const normalizedName = name.toLowerCase();
            targetSkill = allSkills.find(s => (s.name && s.name.trim().toLowerCase() === normalizedName) || s.id === name);
        }

        let savedSkill: Skill;
        let isUpdate = false;

        if (targetSkill) {
            isUpdate = true;
            savedSkill = {
                ...targetSkill,
                name: name || targetSkill.name,
                description: description || targetSkill.description,
                content: content || targetSkill.content,
                category: category || targetSkill.category || 'lessons_learned',
                scope: scope || targetSkill.scope || 'local',
                language: language || targetSkill.language || 'markdown',
                timestamp: Date.now()
            };
            await skillsManager.addOrUpdateSkill(savedSkill);
        } else {
            const generatedId = skillId || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skill'}-${Date.now()}`;
            savedSkill = {
                id: generatedId,
                name: name,
                description: description,
                content: content,
                category: category,
                scope: scope,
                language: language,
                timestamp: Date.now()
            };
            await skillsManager.addSkill(savedSkill);
        }

        // Attach to the active discussion context and project if requested
        const discussion = env.agentManager?.getCurrentDiscussion?.() || (env.agentManager as any)?.currentDiscussion;
        if (discussion && shouldAddToContext) {
            if (!discussion.importedSkills) {
                discussion.importedSkills = [];
            }
            if (!discussion.importedSkills.includes(savedSkill.id)) {
                discussion.importedSkills.push(savedSkill.id);
            }

            if (scope === 'local' && env.contextManager) {
                await env.contextManager.addSkillToProject(savedSkill.id);
            }

            // Trigger HUD and token calculation refresh
            if (env.agentManager?.ui) {
                (env.agentManager.ui as any).updateContextAndTokens?.({ isBackgroundSync: false });
            }
        }

        const actionWord = isUpdate ? "Updated existing skill" : "Built new skill";
        return {
            success: true,
            output: `✅ **${actionWord} successfully:** '${savedSkill.name}' (ID: \`${savedSkill.id}\` | Scope: \`${savedSkill.scope}\` | Category: \`${savedSkill.category}\`)
${shouldAddToContext ? "🎓 **Active in context**: Attached to current workspace reasoning stream." : ""}

\`\`\`skill
<skill title="${savedSkill.name}" description="${savedSkill.description}" category="${savedSkill.category}" id="${savedSkill.id}">
${savedSkill.content}
</skill>
\`\`\``
        };
    }
};