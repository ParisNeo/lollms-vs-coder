import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';

export const runTestsAndFixTool: ToolDefinition = {
    name: "run_tests_and_fix",
    description: "Autonomously executes project tests (pytest, jest, npm test) in an iterative TDD loop (test -> code -> auto-apply -> test -> ...) until all tests succeed.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters: [
        { name: "test_command", type: "string", description: "The command to run tests (e.g., 'pytest', 'npm test').", required: true },
        { name: "max_iterations", type: "number", description: "Optional maximum repair iterations (default: 8).", required: false }
    ],
    async execute(params: { test_command: string, max_iterations?: number }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.agentManager) return { success: false, output: "Agent environment required." };

        const testCmd = params.test_command || "pytest";
        const maxIter = params.max_iterations || 8;
        const res = await env.agentManager.runTestDrivenLoop(testCmd, signal, maxIter);

        if (res.success) {
            return {
                success: true,
                output: `✅ TDD Loop Succeeded in ${res.iterations} iteration(s)! All tests passed.\nCommand: \`${testCmd}\`\nOutput:\n${res.output}`
            };
        } else {
            return {
                success: false,
                output: `🛑 TDD Loop finished with remaining failures after ${res.iterations} iteration(s).\nCommand: \`${testCmd}\`\nLast Test Output:\n${res.output}`
            };
        }
    }
};