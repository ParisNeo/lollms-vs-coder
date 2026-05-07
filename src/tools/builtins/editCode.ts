import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { applySearchReplace, getProcessedSystemPrompt, stripThinkingTags } from '../../utils';
import { ChatMessage } from '../../lollmsAPI';
import * as path from 'path';
import { Logger } from '../../logger';
/**
 * Enhanced System Prompt for the Editor sub-agent.
 * Similar to generateCode but specialized for surgical modification.
 */
async function getEditorSystemPrompt(
    customPrompt: string, 
    planObjective: string, 
    projectContext: any, 
    briefing: string,
    params: any,
    env: ToolExecutionEnv
): Promise<ChatMessage> {
    const agentPersonaPrompt = await getProcessedSystemPrompt('agent', undefined, undefined, undefined, false, projectContext);
    const { getEnvironmentAwarenessBlock } = require('../../utils');
    const envBlock = await getEnvironmentAwarenessBlock();

    let injectedData = "";
    if (params.inject_task_outputs && env.currentPlan) {
        params.inject_task_outputs.forEach((id: number) => {
            const task = env.currentPlan?.tasks.find(t => t.id === id);
            if (task && task.result) {
                injectedData += `\n### 📥 INPUT DATA (TASK ${id} RESULT):\n${task.result}\n`;
            }
        });
    }

    const fullContent = `${agentPersonaPrompt}

    ${envBlock}

    ${injectedData}

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
        { name: "equip_skills", type: "array", description: "List of skill IDs to inject into the sub-agent context.", required: false },
        { name: "research_briefing", type: "string", description: "Distilled research results to inform the refactor.", required: false },
        { name: "inject_task_outputs", type: "array", description: "List of task IDs to pull results from and inject into the system prompt.", required: false },
        { name: "instructions", type: "string", description: "Detailed instructions on what to change.", required: true }
        ],
        async execute(params: { file_path: string, equip_skills?: string[], research_briefing?: string, inject_task_outputs?: number[], instructions: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot || !env.currentPlan) return { success: false, output: "Error: Workspace root or active plan missing." };

        let filePath = params.file_path.trim().replace(/^[\\\/]+/, '').replace(/^[A-Z]:[\\\/]/i, '');
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

        // 1. BACKUP (Protocol Step 1)
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(filePath).digest('hex').substring(0, 8);
        const patchesDir = vscode.Uri.joinPath(env.workspaceRoot.uri, '.lollms', 'patches');
        const backupUri = vscode.Uri.joinPath(patchesDir, `${hash}_${path.basename(filePath)}.bak`);

        try {
            await vscode.workspace.fs.createDirectory(patchesDir);
            await vscode.workspace.fs.writeFile(backupUri, Buffer.from(originalContent, 'utf8'));
        } catch (err) {
            Logger.warn(`[edit_code] Backup failed for ${filePath}, proceeding anyway.`);
        }

        // 2. GATHER GROUNDING INFO
        const briefing = env.contextManager.renderBriefing(currentDiscussion);
        const discussionSkills = currentDiscussion?.importedSkills || [];
        const taskSkills = env.taskSkills || [];
        const importedSkills = Array.from(new Set([...discussionSkills, ...taskSkills]));

        let contextData = { tree: '', files: '', skills: '' };
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

        // 3. SURGICAL REPAIR LOOP (Protocol Step 2-4)
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const maxRetries = config.get<number>('agentMaxRetries') || 2;
        let attempts = 0;
        let lastFailureReason = "";
        let workingContent = originalContent;

        const objective = env.currentPlan.objective;

        while (attempts <= maxRetries) {
            if (signal.aborted) return { success: false, output: "Operation cancelled." };

            const systemPrompt = await getEditorSystemPrompt(
                params.instructions,
                objective,
                contextData,
                briefing,
                params,
                env
            );

            let userPrompt = `### TARGET FILE: ${filePath}\n\`\`\`\n${originalContent}\n\`\`\`\n\n### INSTRUCTION\n${params.instructions}`;
            if (attempts > 0) {
                userPrompt = `### 🚨 PREVIOUS ATTEMPT FAILED\nREASON: ${lastFailureReason}\n\n${userPrompt}\n\n**STRICT**: Fix your search block. It must match the file content ABOVE character-for-character.`;
            }

            const response = await env.lollmsApi.sendChat([
                systemPrompt,
                { role: 'user', content: userPrompt }
            ], null, signal, modelOverride);

            const cleanResponse = stripThinkingTags(response);
            const normalizedResponse = cleanResponse.replace(/^\s*(<<<<<<< SEARCH|=======|>>>>>>> REPLACE)/gm, '$1');
            const aiderRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
            const matches = [...normalizedResponse.matchAll(aiderRegex)];

            if (matches.length === 0) {
                attempts++;
                lastFailureReason = "No valid Aider SEARCH/REPLACE blocks found in your response.";
                continue;
            }

            let currentAppliedCount = 0;
            let currentErrors: string[] = [];
            let tempWorkingContent = originalContent;

            for (const match of matches) {
                const result = applySearchReplace(tempWorkingContent, match[1], match[2]);
                if (result.success) {
                    tempWorkingContent = result.result;
                    currentAppliedCount++;
                } else {
                    currentErrors.push(result.error || "Unknown match error");
                }
            }

            // Verify Structural Success (Protocol Step 3)
            if (currentAppliedCount === matches.length) {
                workingContent = tempWorkingContent;

                // Integrity Check (Protocol Step 4 - Marker Leakage)
                const markerLeakage = workingContent.includes('<<<<<<< SEARCH') || 
                                     workingContent.includes('>>>>>>> REPLACE') || 
                                     workingContent.includes('=======');

                if (markerLeakage) {
                    attempts++;
                    lastFailureReason = "CRITICAL ERROR: Aider markers (SEARCH/REPLACE) leaked into the actual code content.";
                    continue;
                }

                // 4. THE GUARDIAN PASS (Protocol Step 5)
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(workingContent, 'utf8'));
                env.contextManager.refreshFileInCache(fileUri);

                let output = `Successfully applied ${currentAppliedCount} surgical edits to \`${filePath}\`.`;

                // --- INTEGRATED SMOKE TEST ---
                const isPython = filePath.endsWith('.py');
                let smokeTestResult = "";
                if (isPython) {
                    const projectRoot = env.workspaceRoot?.uri.fsPath;
                    const checkResult = await env.agentManager!.runCommand(`python -m py_compile "${filePath}"`, signal, { projectRoot });
                    if (!checkResult.success) {
                        smokeTestResult = `\n⚠️ SYNTAX ERROR DETECTED: ${checkResult.output}`;
                    }
                }

                await new Promise(r => setTimeout(r, 1200)); // Wait for language server
                const diagnostics = vscode.languages.getDiagnostics(fileUri)
                    .filter(d => d.severity === vscode.DiagnosticSeverity.Error);

                if (diagnostics.length > 0 || smokeTestResult) {
                    const errorReport = diagnostics.map(d => `[Line ${d.range.start.line + 1}] ${d.message}`).join('\n');

                    // --- RESILIENCY CHECK: Import vs Logic ---
                    const envIssues = diagnostics.filter(d => 
                        d.message.toLowerCase().includes('import') || 
                        d.message.toLowerCase().includes('not resolved') ||
                        d.message.toLowerCase().includes('no module named')
                    );
                    const logicIssues = diagnostics.filter(d => !envIssues.includes(d));

                    if (logicIssues.length > 0 || smokeTestResult.includes("SyntaxError")) {
                        // CRITICAL: Rollback and retry
                        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(workingContent, 'utf8'));
                        attempts++;
                        lastFailureReason = `Surgical logic errors detected:\n${errorReport}`;
                        continue;
                    } else {
                        // NON-CRITICAL: Keep the file but alert the Architect
                        const depReport = `### ⚖️ PARTIAL SUCCESS: ${filePath}
                        Your code changes were applied to disk, but the environment is missing dependencies:
                        ${envIssues.map(d => `- ${d.message}`).join('\n')}

                        **MANDATORY ARCHITECT ACTION**: 
                        The code is syntactically correct. Do NOT refactor the file. Instead, use 'install_python_dependencies' or 'execute_command' to install the missing libraries.`;

                        return { success: true, output: depReport };
                    }
                }

                // 5. FINAL SUCCESS REPORT (Protocol Step 6)
                const report = `### ✅ EDIT SUCCESSFUL: ${filePath}
        - **Retries**: ${attempts}
        - **Matches**: ${currentAppliedCount} blocks applied.
        - **Guardian**: Syntax and imports verified clean.

        **Changes Summary**: 
        ${params.instructions}`;

                return { success: true, output: report };

            } else {
                attempts++;
                lastFailureReason = `Failed to match ${matches.length - currentAppliedCount} out of ${matches.length} blocks.\nErrors: ${currentErrors.join(', ')}`;
                // Restore logic: simply don't update workingContent and let loop retry with original
            }
        }

        // Final Failure: Restore from backup (Protocol Step 4 fallback)
        try {
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(originalContent, 'utf8'));
        } catch {}

        return { 
            success: false, 
            output: `🛑 MISSION FAILED after ${attempts} attempts.\n\nLAST ERROR: ${lastFailureReason}\n\nADVICE: Re-read the file to ensure your mental model matches the current disk state before trying again.` 
        };
        }
};