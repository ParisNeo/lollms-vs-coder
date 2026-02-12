import * as vscode from 'vscode';
import * as os from 'os';
import { DiscussionCapabilities, getAvailableShells, ResponseProfile } from './utils';

export class PromptTemplates {
    
    private static getFormatInstructions(capabilities?: DiscussionCapabilities, forceFullCodeSetting?: boolean): string {
        const useFull = capabilities?.generationFormats?.fullFile ?? true;
        const partialFormat = capabilities?.generationFormats?.partialFormat ?? 'aider';
        const forceFull = forceFullCodeSetting || capabilities?.forceFullCode || false;

        let sections = [];

        sections.push(`
### 🚦 CODE GENERATION DECISION LOGIC
1. **NEW FILE**: You MUST use the **FULL FILE** format.
2. **SUBSTANTIAL MODIFICATIONS**: For major refactors or changes affecting many parts of a file, you MUST use the **FULL FILE** format.
3. **SMALL CHANGES**: For surgical, localized edits, you MAY use the ${partialFormat.toUpperCase()} format.
4. **MULTIPLE BLOCKS**: You may provide multiple ${partialFormat.toUpperCase()} blocks for the same file if the changes are in different parts of the file.
`);

        if (forceFull) {
            sections.push(`
### 📄 FORMAT: FULL FILE CONTENT (ENFORCED)
**CRITICAL**: You must always provide the complete file content. Partial updates are currently disabled.
**Rule**: Output the entire file from line 1 to the end. No placeholders.
**Example**:
\`\`\`python:src/utils.py
[FULL CODE HERE]
\`\`\`
`);
        }
        if (partialFormat === 'aider') {
                sections.push(`
### ⚡ FORMAT: SEARCH/REPLACE (AIDER STYLE)
**Use for**: Small, surgical edits (preferred when less than 70% of the file changes).
**Format**: \`\`\`language:path/to/file
**Rule**:
1. The \`<<<<<<< SEARCH\` block must match the existing file content character-for-character (including exact indentation).
2. The replacement code goes between the \`=======\` and \`>>>>>>> REPLACE\` markers.
3. Do *not* include line numbers.
4. Provide only one block per file unless changes are far apart.

**Example**:
\`\`\`javascript:src/index.js
<<<<<<< SEARCH
function greet() {
    console.log("Hello World");
}
=======
function greet(name = "User") {
    console.log(\`Hello \${name}\`);
}
>>>>>>> REPLACE
\`\`\`
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
