import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { stripThinkingTags } from '../../utils';
import { ChatMessage } from '../../lollmsAPI';
import * as path from 'path';

export const generateCodeTool: ToolDefinition = {
    name: "generate_code",
    description: "Delegates file creation to a specialist agent. The Architect provides a profile, reference files, a technical briefing, and implementation details.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_write',
    parameters: [
        { name: "file_path", type: "string", description: "The relative path of the file to manifest.", required: true },
        { name: "specialist_profile", type: "string", description: "The persona to use: 'frontend', 'backend', 'devops', 'security', 'data_scientist'.", required: true },
        { name: "technical_briefing", type: "string", description: "High-level context discovered by the Architect.", required: true },
        { name: "research_briefing", type: "string", description: "Specific data recovered from web searches or external research.", required: false },
        { name: "equip_skills", type: "array", description: "List of skill IDs from the library to give the agent (e.g. ['fastapi_standards']).", required: false },
        { name: "instructions", type: "string", description: "Detailed implementation requirements for this specific file.", required: true },
        { name: "reference_files", type: "array", description: "List of existing relative file paths the specialist should read for context.", required: false },
        { name: "include_tree", type: "boolean", description: "Set to true if the specialist needs to see the whole project structure.", required: false }
    ],
    async execute(params: { 
        file_path: string, 
        specialist_profile: string, 
        technical_briefing: string, 
        research_briefing?: string,
        equip_skills?: string[],
        instructions: string, 
        reference_files?: string[],
        include_tree?: boolean 
    }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "Error: No workspace root." };

        const model = env.taskModel || env.lollmsApi.getModelName();
        
        // 1. ASSEMBLE MISSION CONTEXT (RESEARCH & SKILLS)
        let skillContent = "";
        if (params.equip_skills && params.equip_skills.length > 0 && env.skillsManager) {
            const allSkills = await env.skillsManager.getSkills();
            params.equip_skills.forEach(id => {
                const s = allSkills.find(sk => sk.id === id);
                if (s) {
                    skillContent += `\n#### 💎 SOURCE OF TRUTH: ${s.name.toUpperCase()}\n${s.content}\n`;
                }
            });
        }

        let referenceContent = "";
        if (params.reference_files && params.reference_files.length > 0) {
            referenceContent = await env.contextManager.readSpecificFiles(params.reference_files);
        }

        const projectTree = params.include_tree 
            ? (await env.contextManager.getContextContent({ includeTree: true, modelName: model, signal })).projectTree
            : "(Tree omitted for brevity)";

        // 2. DEFINE SPECIALIST PERSONA
        const profileMap: Record<string, string> = {
            'frontend': 'You are a Senior Frontend Architect expert in UX, accessibility, and modern frameworks (React/Vue/Tailwind).',
            'backend': 'You are a Senior Backend Engineer expert in scalable APIs, database integrity, and security (Node/FastAPI/Python).',
            'devops': 'You are a DevOps Specialist expert in CI/CD, Docker, and infrastructure as code.',
            'security': 'You are a Security Auditor. You write code that is hardened against injection, XSS, and auth bypass.',
            'data_scientist': 'You are a Data Scientist expert in efficient tensor operations, numpy, and model evaluation.'
        };
        const persona = profileMap[params.specialist_profile.toLowerCase()] || "You are a Senior Software Engineer.";

        // 3. CONSTRUCT THE HUMAN-LIKE PROMPT
        const systemPrompt = `${persona}

        # 🎯 MISSION: CREATE FILE
        You are being delegated a task by the Lead Architect. 

        ${skillContent ? `## 📖 EQUIPPED PROTOCOLS (MANDATORY RULES)\n${skillContent}\n` : ""}

        ## 📋 SHARED TEAM BRIEFING (GROUND TRUTH)
        ${params.technical_briefing}

        ${params.research_briefing ? `## 🌍 EXTERNAL RESEARCH DISCOVERIES\n${params.research_briefing}\n` : ""}

        ## 🏗️ PROJECT STRUCTURE
${projectTree}

## 🛠️ REFERENCE FILES (DEPENDENCIES)
${referenceContent || "None provided."}

## 🚀 YOUR TASK
Create the file: \`${params.file_path}\`
Follow these specific instructions:
${params.instructions}

## 🛑 STRICTOR OUTPUT RULES:
1. Provide the **100% COMPLETE** content of the file. No snippets.
2. **ZERO-PLACEHOLDER RULE**: You are strictly FORBIDDEN from using comments like \`// ... existing code\` or \`# ... rest of imports\`. Every single line must be written explicitly.
3. Output **ONLY** the code inside a standard Markdown block (e.g. \` \`\`\`python ... \` \`).
4. Do **NOT** include any conversational chatter or explanations. Just the file content.
`;

        // 4. CALL SPECIALIST
        const response = await env.lollmsApi.sendChat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Manifest the file: ${params.file_path}` }
        ], null, signal, model);

        // 5. EXTRACT AND APPLY (APPLY ALL)
        const cleanResponse = stripThinkingTags(response);
        const codeBlockRegex = /```(?:\w+)?[:\w.\/-]*[\r\n]+([\s\S]+?)[\r\n]+```/;
        const match = cleanResponse.match(codeBlockRegex);
        const finalCode = match ? match[1].trim() : cleanResponse.trim();

        if (finalCode.length < 10) {
            return { success: false, output: "Error: Specialist produced insufficient or empty code." };
        }

        const fullUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);
        const parentDir = vscode.Uri.joinPath(fullUri, '..');
        
        await vscode.workspace.fs.createDirectory(parentDir);
        await vscode.workspace.fs.writeFile(fullUri, Buffer.from(finalCode, 'utf8'));

        // 6. GENERATE FINAL AUDIT REPORT
        await new Promise(r => setTimeout(r, 800)); // Wait for VS Code diagnostics
        const diagnostics = vscode.languages.getDiagnostics(fullUri);
        const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);

        let report = `### 🛰️ DELEGATION REPORT: ${params.file_path}\n`;
        report += `**Specialist Profile:** ${params.specialist_profile}\n`;
        report += `**Status:** File manifested on disk.\n\n`;
        report += `**Code Snippet (Preview):**\n\`\`\`${path.extname(params.file_path).substring(1)}\n${finalCode.substring(0, 300)}...\n\`\`\`\n\n`;
        
        if (errors.length === 0) {
            report += `✅ **Guardian Audit**: 0 functional errors detected. Implementation verified.`;
        } else {
            report += `⚠️ **Guardian Audit Flagged Issues**:\n`;
            errors.forEach(e => report += `- [L${e.range.start.line + 1}] ${e.message}\n`);
            report += `\n**Architect Note**: The specialist introduced syntax errors. Please use 'edit_code' to fix them.`;
        }

        return { success: errors.length === 0, output: report };
    }
};