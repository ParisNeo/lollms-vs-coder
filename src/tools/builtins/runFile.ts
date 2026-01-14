import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';

export const runFileTool: ToolDefinition = {
    name: "run_file",
    description: "Executes a file in the workspace using the appropriate interpreter based on its extension. Returns stdout and stderr for verification.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "file_path", type: "string", description: "Relative path to the file to execute.", required: true },
        { name: "args", type: "string", description: "Optional command line arguments to pass to the script.", required: false }
    ],
    async execute(params: { file_path: string, args?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }
        if (!env.agentManager) {
             return { success: false, output: "Error: Agent capabilities not available." };
        }

        const filePath = params.file_path;
        const ext = path.extname(filePath).toLowerCase();
        let command = "";
        
        // Handle arguments
        const argsStr = params.args ? ` ${params.args}` : "";

        // Determine execution command based on extension
        switch (ext) {
            case '.py':
                // Uses 'python'. If a specific venv is needed, use execute_python_script or execute_command
                command = `python "${filePath}"${argsStr}`;
                break;
            case '.js':
                command = `node "${filePath}"${argsStr}`;
                break;
            case '.ts':
                // Uses npx to ensure we use a local ts-node if installed, or download it if necessary/configured
                // Alternatively could assume global ts-node
                command = `npx ts-node "${filePath}"${argsStr}`;
                break;
            case '.sh':
                command = `bash "${filePath}"${argsStr}`;
                break;
            case '.ps1':
                command = `powershell -ExecutionPolicy Bypass -File "${filePath}"${argsStr}`;
                break;
            case '.bat':
            case '.cmd':
                command = `"${filePath}"${argsStr}`;
                break;
            case '.rb':
                command = `ruby "${filePath}"${argsStr}`;
                break;
            case '.go':
                command = `go run "${filePath}"${argsStr}`;
                break;
            default:
                // Try executing as a direct binary/script
                command = `"${filePath}"${argsStr}`;
                break;
        }

        return await env.agentManager.runCommand(command, signal);
    }
};
