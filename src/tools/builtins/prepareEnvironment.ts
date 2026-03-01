import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const prepareEnvironmentTool: ToolDefinition = {
    name: "prepare_environment",
    description: "An integrated macro tool to prepare development environments for various platforms (python, node, ros, c, cpp). It cleans existing environment folders and initializes the workspace according to platform standards.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { 
            name: "platform", 
            type: "string", 
            description: "The target platform: 'python', 'node', 'ros', 'c', or 'cpp'.", 
            required: true 
        },
        { 
            name: "env_name", 
            type: "string", 
            description: "Optional name for the environment folder (mainly used for python 'venv' or 'env').", 
            required: false 
        }
    ],
    async execute(params: { platform: string, env_name?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const platform = params.platform.toLowerCase();
        const envName = params.env_name || (platform === 'python' ? 'venv' : '');
        const isWin = process.platform === 'win32';
        
        let command = "";

        switch (platform) {
            case 'python': {
                // Intelligent environment detection and preservation
                const possibleEnvs =['.venv', 'venv', 'env'];
                let foundEnv = '';
                if (env.workspaceRoot) {
                    const fs = require('fs/promises');
                    const path = require('path');
                    for (const e of possibleEnvs) {
                        try {
                            const p = path.join(env.workspaceRoot.uri.fsPath, e);
                            const stat = await fs.stat(p);
                            if (stat.isDirectory()) {
                                foundEnv = e;
                                break;
                            }
                        } catch { }
                    }
                }
                
                const targetEnv = foundEnv || envName || '.venv';
                if (env.agentManager) env.agentManager.sessionState.activeEnv = targetEnv;

                if (foundEnv) {
                    return { success: true, output: `Found existing Python environment: '${foundEnv}'. Ready to use.` };
                }

                if (isWin) {
                    command = `python -m venv "${targetEnv}"`;
                } else {
                    command = `python3 -m venv "${targetEnv}" || python -m venv "${targetEnv}"`;
                }
                break;
            }

            case 'node':
                // Check if package.json exists, if not init. Then install.
                if (isWin) {
                    command = `if (-not (Test-Path "package.json")) { npm init -y }; npm install`;
                } else {
                    command = `[ ! -f package.json ] && npm init -y; npm install`;
                }
                break;

            case 'ros':
                // ROS2 standard initialization macro
                if (isWin) {
                    command = `if (-not (Test-Path "src")) { New-Item -ItemType Directory -Path "src" }; colcon build`;
                } else {
                    command = `mkdir -p src && colcon build`;
                }
                break;

            case 'c':
            case 'cpp':
                // Prepare build directory and placeholder CMake if missing
                if (isWin) {
                    command = `
                        if (-not (Test-Path "build")) { New-Item -ItemType Directory -Path "build" };
                        if (-not (Test-Path "CMakeLists.txt")) { 
                            'cmake_minimum_required(VERSION 3.10)\nproject(LollmsProject)\nadd_executable(main main.cpp)' | Out-File -FilePath "CMakeLists.txt" -Encoding utf8 
                        }
                    `.trim();
                } else {
                    command = `mkdir -p build; [ ! -f CMakeLists.txt ] && echo "cmake_minimum_required(VERSION 3.10)\nproject(LollmsProject)\nadd_executable(main main.cpp)" > CMakeLists.txt`;
                }
                break;

            default:
                return { success: false, output: `Unsupported platform: ${platform}` };
        }

        if (!env.agentManager) {
            return { success: false, output: "Error: Agent Manager not available in environment." };
        }

        return await env.agentManager.runCommand(command, signal);
    }
};
