import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';
import * as fs from 'fs/promises';

export const rlmReplTool: ToolDefinition = {
    name: "rlm_repl",
    description: "Executes Python code in a stateful REPL style. The code has access to the full project 'context' (Prompt as Variable) and a persistent 'thread_memory' dictionary that survives across calls. Use this for complex multi-step reasoning, data extraction, or iterative code refinement.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters: [
        { name: "code", type: "string", description: "The Python code to execute. Variables assigned to the 'thread_memory' dict will be preserved.", required: true },
        { name: "inspect_context", type: "boolean", description: "Whether to inject the current project file tree and selected contents as a string variable named 'context'.", required: false }
    ],
    async execute(params: { code: string, inspect_context?: boolean }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot || !env.agentManager) {
            return { success: false, output: "Agent environment not ready." };
        }

        // Prepare the persistent memory injection
        const threadMemoryJson = JSON.stringify(env.agentManager.sessionState.replVariables);
        
        let contextInjection = "";
        if (params.inspect_context) {
            const contextData = await env.contextManager.getContextContent();
            contextInjection = `context = r"""${contextData.text.replace(/"/g, '\\"')}"""\n`;
        }

        // Wrap the user's code to support persistent memory updates
        // We use a temp python script that reads memory from JSON, runs code, then outputs updated memory as JSON to a file
        const wrapperCode = `
import json
import os

# 1. Load Persistent Thread Memory
thread_memory = json.loads(r'''${threadMemoryJson}''')

# 2. Inject Context if requested
${contextInjection}

# 3. User Code Execution
try:
${params.code.split('\n').map(line => '    ' + line).join('\n')}
except Exception as e:
    print(f"REPL_ERROR: {e}")

# 4. Save Updated Memory
with open(".lollms/repl_memory.json", "w") as f:
    json.dump(thread_memory, f)
`.trim();

        const tempFilePath = path.join(env.workspaceRoot.uri.fsPath, ".lollms", "temp_repl.py");
        await fs.mkdir(path.dirname(tempFilePath), { recursive: true });
        await fs.writeFile(tempFilePath, wrapperCode);

        // Run the script using the active environment if set
        let pythonExec = "python";
        if (env.agentManager.sessionState.activeEnv) {
            const isWin = process.platform === 'win32';
            pythonExec = isWin 
                ? path.join(env.agentManager.sessionState.activeEnv, 'Scripts', 'python.exe')
                : path.join(env.agentManager.sessionState.activeEnv, 'bin', 'python');
        }

        const result = await env.agentManager.runCommand(`"${pythonExec}" "${tempFilePath}"`, signal);

        // Update persistent memory from the output file
        try {
            const memPath = path.join(env.workspaceRoot.uri.fsPath, ".lollms", "repl_memory.json");
            const updatedMemStr = await fs.readFile(memPath, 'utf8');
            env.agentManager.sessionState.replVariables = JSON.parse(updatedMemStr);
        } catch (e) {
            // Memory file might not have been written if script crashed hard
        }

        return result;
    }
};
