import * as vscode from 'vscode';
import * as os from 'os';
import { DiscussionCapabilities, getAvailableShells, ResponseProfile } from './utils';

export class PromptTemplates {
    
    private static getFormatInstructions(capabilities?: DiscussionCapabilities, forceFullCodeSetting?: boolean): string {
        const partialFormat = capabilities?.generationFormats?.partialFormat ?? 'aider';
        const forceFull = forceFullCodeSetting || capabilities?.forceFullCode || false;

        let sections = [];

        sections.push(`
### 🚦 CODE GENERATION DECISION LOGIC
1. **NEW FILE**: You MUST use the **FULL FILE** format.
2. **HUGE CHANGES (>50%)**: If you are changing more than 50% of the file, use the **FULL FILE** format.
3. **STANDARD EDITS (<50%)**: For most edits, you MUST use the ${partialFormat.toUpperCase()} format. Do NOT output the full file for small changes.
4. **MULTIPLE BLOCKS**: You may provide multiple ${partialFormat.toUpperCase()} blocks for the same file if the changes are in different parts of the file.
`);

        if (forceFull) {
            sections.push(`
### 📄 FORMAT: FULL FILE CONTENT (ENFORCED)
**CRITICAL**: You must always provide the complete file content. Partial updates are currently disabled.
**Rule**: Output the entire file from line 1 to the end. No placeholders.
**Structure**:
\`\`\`python:src/utils.py
[FULL CODE HERE]
\`\`\`
**Replace [FULL CODE HERE] with the actual code **
`);
        }
        if (partialFormat === 'aider') {
                sections.push(`
### ⚡ FORMAT: SEARCH/REPLACE (AIDER STYLE)
**Use for**: Standard edits (less than 50% of file changed).
**Format**: \`\`\`language:path/to/file
<<<<<<< SEARCH
[EXACT content to find including context]
=======
[NEW content to replace with including context]
>>>>>>> REPLACE
\`\`\`

**RULES:**
1. **SEARCH BLOCK**: Must contain *exact* lines from the file (including indentation). If it doesn't match, the edit fails.
2. **REPLACE BLOCK**: Must contain the *entire* replacement code, including the surrounding context lines you matched.
3. **CONTEXT**: Include 3-4 lines of unchanged context before and after the modification in BOTH blocks.
4. **CONTAINMENT**: All code changes must be *inside* the \`=======\` and \`>>>>>>> REPLACE\` markers. Content outside is ignored.
5. **NO ELLIPSIS**: Do not use "..." to skip code in the SEARCH block.
6. **NO LINE NUMBERS**: Do not include line numbers.
7. **SMALL CHUNKS**: Prefer multiple small SEARCH/REPLACE blocks over one large block. Large blocks are prone to matching errors.
`);
    }
    else
        if (partialFormat === 'diff')
    {
                sections.push(`
### 🛠️ FORMAT: UNIFIED DIFF
**Use for**: Standard patch applications.
**Example**:
\`\`\`diff:src/styles.css
--- a/src/styles.css
+++ b/src/styles.css
@@ -1,4 +1,4 @@
 body {
-    background: white;
+    background: var(--bg-color);
     margin: 0;
 }
\`\`\`
`);
    }
    sections.push(`
### 🚫 FORBIDDEN BEHAVIORS
- **NO SNIPPETS**: Never output code without a path or a patch format.
- **NO PLACEHOLDERS**: Never use \`# ... rest of code stays same\`.
- **NO MULTIPLE PATCHES**: Do not provide two separate diffs/aider blocks for the same path.

### 🎨 INTEGRATED UI COMPONENTS
You can trigger specialized UI blocks by using these XML-like tags:

1. **Image Generation**: Propose generating an asset (UI button appears).
   Format: <generateImage prompt="detailed description" path="relative/path/to/save.png" width="1024" height="1024" />
   
2. **Skill Building**: Propose a reusable pattern or knowledge block.
   Format: 
   <skill title="Skill Name">
   [Brief description of the pattern]
   \`\`\`language
   [Code or instructions]
   \`\`\`
   </skill>

3. **File Operations**: Propose moving, renaming or deleting files (UI buttons appear).
   Formats:
   - Rename/Move: <rename old="path/to/old_file.ext" new="path/to/new_file.ext" />
   - Delete: <delete path="path/to/file_to_remove.ext" />
`);

        return sections.join('\n');
    }
    public static async getSystemPrompt(
        promptType: 'chat' | 'agent' | 'inspector' | 'commit',
        capabilities?: DiscussionCapabilities,
        customPersonaContent?: string,
        memory?: string,
        forceFullCode?: boolean,
        context?: { tree: string, files: string, skills: string }
    ): Promise<string> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const userName = config.get<string>('userInfo.name') || 'Developer';
        
        const profiles = config.get<ResponseProfile[]>('responseProfiles') || [];
        const activeProfileId = capabilities?.responseProfileId || config.get<string>('defaultResponseProfileId') || 'balanced';
        const activeProfile = profiles.find(p => p.id === activeProfileId) || profiles[0];

        let persona = customPersonaContent || config.get<string>(
            promptType === 'chat' ? 'chatPersona' :
            promptType === 'agent' ? 'agentPersona' :
            promptType === 'inspector' ? 'codeInspectorPersona' :
            'commitMessagePersona'
        ) || "You are an expert software engineer.";

        const formatting = this.getFormatInstructions(capabilities, forceFullCode);
        const shells = await getAvailableShells();

        const env = `
### ENVIRONMENT INFO
- OS: ${os.platform()}
- Date: ${new Date().toISOString().split('T')[0]}
- Available Shells: ${shells.join(', ')}
${memory ? `\n### LONG-TERM MEMORY\n${memory}` : ''}`;

        // --- ENHANCED STYLE INSTRUCTIONS ---
        const responseInstructions = activeProfile ? `
### 📢 CRITICAL RESPONSE STYLE: ${activeProfile.name.toUpperCase()}
You MUST adhere to this style for EVERY turn in this conversation:
${activeProfile.systemPrompt}
` : "";
        const prefix = (activeProfile && activeProfile.prefix) ? activeProfile.prefix + "\n" : "";

        return `${prefix}# ROLE
${persona}

# CONTEXT
${context?.skills || ''}
${context?.tree || ''}
${context?.files || ''}

# INSTRUCTIONS
${formatting}
${responseInstructions}
${env}
`;
    }
}
