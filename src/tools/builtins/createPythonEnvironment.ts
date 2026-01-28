import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as fs from 'fs/promises';
import * as path from 'path';

export const createPythonEnvironmentTool: ToolDefinition = {
    name: "create_python_environment",
    description: "Prepares a Python virtual environment. If an environment already exists, it asks the user to delete it, rename the new one, or adopt the existing one.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "env_name", type: "string", description: "The preferred name of the environment folder (e.g., 'venv').", required: true }
    ],
    async execute(params: { env_name: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.env_name) {
            return { success: false, output: "Error: 'env_name' is required." };
        }

        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No workspace folder." };
        }

        const envPath = path.join(env.workspaceRoot.uri.fsPath, params.env_name);
        let finalEnvName = params.env_name;

        try {
            await fs.access(envPath);
            
            // Environment exists! Ask user for decision.
            const question = `An environment named '${params.env_name}' already exists in the workspace. How should I proceed?
1. Delete it and create a fresh one.
2. Keep it and use another name for the new environment.
3. Use the existing one (Skip creation).`;

            const choice = await env.agentManager.requestUserInput(question, signal);
            
            if (choice.includes('1')) {
                // Delete
                const isWin = process.platform === 'win32';
                const delCmd = isWin ? `Remove-Item -Recurse -Force "${params.env_name}"` : `rm -rf "${params.env_name}"`;
                await env.agentManager.runCommand(delCmd, signal);
            } else if (choice.includes('2')) {
                // Rename
                const newName = await env.agentManager.requestUserInput("Please enter the new environment name:", signal);
                finalEnvName = newName.trim();
            } else if (choice.includes('3')) {
                // Adopt
                env.agentManager.sessionState.activeEnv = finalEnvName;
                env.agentManager.sessionState.environmentHistory.push(`Adopted existing: ${finalEnvName}`);
                return { success: true, output: `Adopted existing environment: ${finalEnvName}. Skipping creation.` };
            } else {
                return { success: false, output: "Invalid user choice. Operation aborted." };
            }

        } catch (e) {
            // Path does not exist, safe to create.
        }

        // --- Execute Creation ---
        const isWin = process.platform === 'win32';
        let command: string;

        if (isWin) {
            command = `
                $success = $false;
                foreach ($cmd in @('python', 'python3', 'py')) {
                    try {
                        & $cmd -m venv "${finalEnvName}" 2>$null;
                        if ($LASTEXITCODE -eq 0) { $success = $true; break; }
                    } catch {}
                }
                if (-not $success) { throw "Could not find a valid python command to create venv." }
            `.trim();
        } else {
            command = `python3 -m venv "${finalEnvName}" || python -m venv "${finalEnvName}"`;
        }

        const result = await env.agentManager.runCommand(command, signal);
        
        if (result.success) {
            env.agentManager.sessionState.activeEnv = finalEnvName;
            env.agentManager.sessionState.environmentHistory.push(`Created: ${finalEnvName}`);
        }

        return result;
    }
};
