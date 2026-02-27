import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';
import * as fs from 'fs/promises';

export const rlmReplTool: ToolDefinition = {
    name: "rlm_repl",
    description: "Executes Python code in a stateful REPL style. The code has access to the full project 'context' (as variable 'context') and a persistent 'thread_memory' dictionary that survives across calls. This dictionary is automatically populated with data from previous tasks that used 'save_as'.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters: [
        { name: "code", type: "string", description: "The Python code to execute. Variables in 'thread_memory' persist between calls.", required: true },
        { name: "inspect_context", type: "boolean", description: "Inject current project state into the 'context' variable.", required: false }
    ],
    async execute(params: { code: string, inspect_context?: boolean }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot || !env.agentManager) {
            return { success: false, output: "Agent environment not ready." };
        }

        // --- RLM DATA ZONE PREPARATION ---
        // Convert the Agent's in-memory State to a JSON string for Python ingestion
        const threadMemoryJson = JSON.stringify(env.agentManager.sessionState.replVariables);
        
        let contextInjection = "context = ''\n";
        if (params.inspect_context) {
            const modelName = env.agentManager.getCurrentDiscussion()?.model || env.lollmsApi.getModelName();
            const contextData = await env.contextManager.getContextContent({ modelName });
            // Using raw string literal for safety
            contextInjection = `context = r"""${contextData.text.replace(/"/g, '\\"')}"""\n`;
        }

        // Construct the Stateful Wrapper
        const wrapperCode = `
import json
import os

# 1. Load Data Zone (thread_memory)
# Values saved with 'save_as' in previous tools are here.
thread_memory = json.loads(r'''${threadMemoryJson}''')

# 2. Inject Context
${contextInjection}

# 3. User Logic Execution
# We use a localized scope for the execution to prevent pollution 
# but allow modification of the thread_memory dict.
try:
${params.code.split('\n').map(line => '    ' + line).join('\n')}
except Exception as e:
    print(f"RLM_REPL_ERROR: {e}")

# 4. Save Updated Data Zone
with open(".lollms/repl_memory.json", "w", encoding="utf-8") as f:
    json.dump(thread_memory, f)
`.trim();

        const tempFilePath = path.join(env.workspaceRoot.uri.fsPath, ".lollms", "temp_rlm_repl.py");
        await fs.mkdir(path.dirname(tempFilePath), { recursive: true });
        await fs.writeFile(tempFilePath, wrapperCode);

        // Environment Selection
        let pythonExec = "python";
        if (env.agentManager.sessionState.activeEnv) {
            const isWin = process.platform === 'win32';
            pythonExec = isWin 
                ? path.join(env.agentManager.sessionState.activeEnv, 'Scripts', 'python.exe')
                : path.join(env.agentManager.sessionState.activeEnv, 'bin', 'python');
        }

        const result = await env.agentManager.runCommand(`"${pythonExec}" "${tempFilePath}"`, signal);

        // Recover Updated State
        try {
            const memPath = path.join(env.workspaceRoot.uri.fsPath, ".lollms", "repl_memory.json");
            const updatedMemStr = await fs.readFile(memPath, 'utf8');
            env.agentManager.sessionState.replVariables = JSON.parse(updatedMemStr);
        } catch (e) {
            // Handle script failures gracefully
        }

        return result;
    }
};
