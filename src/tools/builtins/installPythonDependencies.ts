import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';
import * as os from 'os';

export const installPythonDependenciesTool: ToolDefinition = {
    name: "install_python_dependencies",
    description: "Installs Python dependencies using pip in a specified virtual environment.",
    isAgentic: false,
    isDefault: true,
    parameters: [
        { name: "env_name", type: "string", description: "The name of the virtual environment folder.", required: true },
        { name: "dependencies", type: "array", description: "A list of dependencies to install (e.g., ['numpy', 'pandas']).", required: true }
    ],
    async execute(params: { env_name: string, dependencies: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.env_name || !params.dependencies) {
            return { success: false, output: "Error: 'env_name' and 'dependencies' are required." };
        }
        const pythonExec = os.platform() === 'win32'
            ? path.join(params.env_name, 'Scripts', 'python.exe')
            : path.join(params.env_name, 'bin', 'python');
        const deps = params.dependencies.join(' ');
        return env.agentManager.runCommand(`"${pythonExec}" -m pip install ${deps}`, signal);
    }
};
