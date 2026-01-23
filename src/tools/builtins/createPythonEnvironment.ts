import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const createPythonEnvironmentTool: ToolDefinition = {
    name: "create_python_environment",
    description: "Creates a Python virtual environment. It attempts multiple python commands (python, python3, py) for robustness.",
    isAgentic: false,
    isDefault: true,
    parameters: [
        { name: "env_name", type: "string", description: "The name of the environment folder (e.g., 'venv').", required: true }
    ],
    async execute(params: { env_name: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.env_name) {
            return { success: false, output: "Error: 'env_name' is required." };
        }

        // Robust command that tries various python launchers
        // In PowerShell: try { python ... } catch { try { py ... } catch { ... } }
        const isWin = process.platform === 'win32';
        let command: string;

        if (isWin) {
            command = `
                $success = $false;
                foreach ($cmd in @('python', 'python3', 'py')) {
                    try {
                        & $cmd -m venv ${params.env_name} 2>$null;
                        if ($LASTEXITCODE -eq 0) { $success = $true; break; }
                    } catch {}
                }
                if (-not $success) { throw "Could not find a valid python command to create venv." }
            `.trim();
        } else {
            command = `python3 -m venv ${params.env_name} || python -m venv ${params.env_name}`;
        }

        return env.agentManager.runCommand(command, signal);
    }
};
