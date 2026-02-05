import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';
import * as os from 'os';

export const installPythonDependenciesTool: ToolDefinition = {
    name: "install_python_dependencies",
    description: "Installs packages via pip. If it fails, it reports exactly why (e.g. connectivity, no pip, or package not found).",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "env_name", type: "string", description: "Venv folder name.", required: true },
        { name: "dependencies", type: "array", description: "List of strings.", required: true }
    ],
    async execute(params: { env_name: string, dependencies: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const pythonExec = os.platform() === 'win32'
            ? path.join(params.env_name, 'Scripts', 'python.exe')
            : path.join(params.env_name, 'bin', 'python');

        const deps = params.dependencies.join(' ');
        // We use -m pip to ensure we use the pip tied to the specific venv
        const command = `"${pythonExec}" -m pip install ${deps} --retries 2 --timeout 15`;

        const result = await env.agentManager!.runCommand(command, signal);

        if (!result.success) {
            let helpfulError = result.output;
            if (result.output.includes("Retrying") || result.output.includes("timeout")) {
                helpfulError = "NETWORK ERROR: Pip timed out. Check your internet connection or try a different mirror.";
            } else if (result.output.includes("No module named pip")) {
                helpfulError = "ENVIRONMENT ERROR: 'pip' is not installed in this venv. You may need to create it with --with-pip.";
            } else if (result.output.includes("Could not find a version")) {
                helpfulError = `PACKAGE ERROR: One or more of [${deps}] do not exist on PyPI. Check the spelling.`;
            }
            return { success: false, output: helpfulError };
        }

        return result;
    }
};
