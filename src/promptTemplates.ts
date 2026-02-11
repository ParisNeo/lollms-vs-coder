import * as vscode from 'vscode';
import * as os from 'os';
import { DiscussionCapabilities, getAvailableShells, ResponseProfile } from './utils';

export class PromptTemplates {
    
    private static getFormatInstructions(capabilities?: DiscussionCapabilities, forceFullCode?: boolean): string {
        const useFull = capabilities?.generationFormats?.fullFile ?? true;
        const useDiff = capabilities?.generationFormats?.diff ?? false;
        const useAider = capabilities?.generationFormats?.aider ?? false;

        let sections = [];

        sections.push(`
### 🚦 CODE GENERATION DECISION LOGIC
1. **NEW FILE**: You MUST use the **FULL FILE** format.
2. **MULTIPLE CHANGES**: If you need to change code in different parts of the same file, you MUST use the **FULL FILE** format.
3. **SINGLE CHANGE**: If the change is small and localized to one specific area, you MAY use **SEARCH/REPLACE** or **DIFF**.
4. **COLLISION PREVENTION**: Never provide more than one partial block (Diff or Search/Replace) for the same file in a single response.
`);

        if (forceFullCode || (useFull && !useDiff && !useAider)) {
            sections.push(`
### 📄 FORMAT: FULL FILE CONTENT (ENFORCED)
**Rule**: You must output the entire file from line 1 to the end. No placeholders.
**Example**:
\`\`\`python:src/utils.py
import os

def get_env():
    return os.environ.get("MODE", "dev")

if __name__ == "__main__":
    print(get_env())
\`\`\`
`);
        } else {
            if (useFull) {
                sections.push(`
### 📄 FORMAT: FULL FILE CONTENT
**Use for**: New files, major refactors, or multiple changes in one file.
**Example**:
\`\`\`python:src/utils.py
[Full file content...]
\`\`\`
`);
            }
            if (useAider) {
                sections.push(`
### ⚡ FORMAT: SEARCH/REPLACE (Aider Style)
**Use for**: Precise, single-point surgical edits.
**Rule**: The SEARCH block must match the existing code EXACTLY.
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
            if (useDiff) {
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
        }

        sections.push(`
### 🚫 FORBIDDEN BEHAVIORS
- **NO SNIPPETS**: Never output code without a path or a patch format.
- **NO PLACEHOLDERS**: Never use \`# ... rest of code stays same\`.
- **NO MULTIPLE PATCHES**: Do not provide two separate diffs/aider blocks for the same path.
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
