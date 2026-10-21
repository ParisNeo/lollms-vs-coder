import * as vscode from 'vscode';
import * as os from 'os';
import { DiscussionCapabilities } from './utils';
import { CoderPromptBuilder, WorkerPromptBuilder } from './system_prompts/workerPrompt';
import { OrchestratorPromptBuilder } from './system_prompts/orchestratorPrompt';

export { CoderPromptBuilder, WorkerPromptBuilder } from './system_prompts/workerPrompt';
export { LibrarianPromptBuilder } from './system_prompts/librarianPrompt';
export { OrchestratorPromptBuilder } from './system_prompts/orchestratorPrompt';

export class PromptTemplates {

    /**
     * Generates a clean, simplified system prompt specifically for exported contexts.
     */
    public static buildExportSystemPrompt(
        persona: string,
        capabilities?: DiscussionCapabilities
    ): string {
        return CoderPromptBuilder.build({
            promptType: 'chat',
            persona,
            capabilities,
            shells: [],
            isExport: true
        });
    }

    /**
     * Builds the current project state message.
     */
    public static buildProjectStateMessage(context: { 
        tree: string; 
        files: string; 
        skills: string; 
        briefing?: string; 
        memory?: string;   
        isAgentMode?: boolean;
    }): string {
        const possessedFiles: string[] = [];
        const { extractFileBlocks, parseFileTagAttributes } = require('./utils');
        const fileBlocks = extractFileBlocks(context.files);
        if (fileBlocks.length > 0) {
            fileBlocks.forEach((fb: any) => {
                const attrs = parseFileTagAttributes(fb.attrStr, fb.rawContent);
                if (attrs?.path && !possessedFiles.includes(attrs.path)) {
                    possessedFiles.push(attrs.path);
                }
            });
        } else {
            const fileTagMatches = [...context.files.matchAll(/<file\s+([^>]*?)>/gi)];
            if (fileTagMatches.length > 0) {
                fileTagMatches.forEach(m => {
                    const attrs = parseFileTagAttributes(m[1]);
                    if (attrs?.path && !possessedFiles.includes(attrs.path)) {
                        possessedFiles.push(attrs.path);
                    }
                });
            } else {
                const blocks = context.files.split(/```/);
                blocks.forEach(block => {
                    const match = block.match(/^(?:\w+)?:([^\r\n]+)/);
                    if (match) {
                        const path = match[1].trim().split(' ')[0];
                        if (path && !possessedFiles.includes(path)) {
                            possessedFiles.push(path);
                        }
                    }
                });
            }
        }
        const filesInventory = possessedFiles.length > 0 
            ? possessedFiles.map(f => `- \`${f}\` [FULL CONTENT LOADED]`).join('\n')
            : "No files are currently loaded in your context.";

        return `
# 🛠️ ACTUAL PROJECT STATE (LIVING CONTEXT)

### 👁️ ACTIVE CONTEXT INVENTORY (POSSESSED FILES)
The following files are ALREADY loaded into your active memory with full content under 'LOADED FILE CONTENTS':
${filesInventory}

### 🛡️ SOURCE OF TRUTH PROTOCOL
The content under 'LOADED FILE CONTENTS' is your SOLE source of truth. Do NOT assume previous suggested changes were applied unless they appear in the loaded content below.

## 🎯 MISSION BRIEFING (Current Task Instructions)
${context.briefing || 'No specific task-level briefing provided.'}

## 🧬 PROJECT DNA (Global Standards)
${context.memory || 'No global standards defined yet.'}
${context.tree || ''}
${context.files || ''}
`.trim();
    }

    /**
     * Main prompt builder delegating to specialized builders per agent type.
     */
    public static build(
        promptType: 'chat' | 'agent' | 'inspector' | 'commit' | 'surgical_agent' | 'verifier' | 'debugger',
        persona: string,
        memory: string,
        shells: string[],
        capabilities?: DiscussionCapabilities,
        forceFullCodeSetting?: boolean,
        context?: { tree: string; files: string; skills: string; briefing?: string; memory?: string; projectName?: string }
    ): string {
        const isExport = (capabilities as any)?.isExport === true;
        const isFastMode = capabilities?.fastMode === true;

        if (promptType === 'verifier') {
            return OrchestratorPromptBuilder.getVerifierSystemPrompt();
        }

        if (promptType === 'debugger') {
            return OrchestratorPromptBuilder.getDebuggerSystemPrompt();
        }

        if (promptType === 'commit') {
            return `# 🎭 ROLE: CONVENTIONAL COMMIT GENERATOR\n${persona}\n\nGenerate a concise conventional commit message based on the changes. Output ONLY the commit message text.`;
        }

        // Delegate to CoderPromptBuilder for chat and surgical refactoring
        return CoderPromptBuilder.build({
            promptType: promptType === 'surgical_agent' ? 'surgical_agent' : 'chat',
            persona,
            memory,
            shells,
            capabilities,
            forceFullCodeSetting,
            context,
            isFastMode,
            isExport
        });
    }
}
