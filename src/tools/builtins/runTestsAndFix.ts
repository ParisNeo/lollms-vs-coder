import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';

export const runTestsAndFixTool: ToolDefinition = {
    name: "run_tests_and_fix",
    description: "Autonomously executes project tests (pytest, jest, npm test). If tests fail, the agent will analyze the failures and attempt to fix the source code automatically.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters: [
        { name: "test_command", type: "string", description: "The command to run tests (e.g., 'pytest', 'npm test').", required: true },
        { name: "target_files", type: "array", description: "The files to fix if tests fail.", required: true }
    ],
    async execute(params: { test_command: string, target_files: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.agentManager) return { success: false, output: "Agent environment required." };

        // 1. Run Tests
        env.agentManager.ui.addMessageToDiscussion({ role: 'system', content: `🧪 **Guardian:** Running test suite: \`${params.test_command}\`...` });
        const result = await env.agentManager.runCommand(params.test_command, signal);

        if (result.success) {
            return { success: true, output: "✅ Tests passed! No fixes required." };
        }

        // 2. Failure detected - trigger autonomous repair
        env.agentManager.ui.addMessageToDiscussion({ 
            role: 'system', 
            content: `🛑 **Test Failure Detected.** Spawning Repair Agent for files: ${params.target_files.join(', ')}...` 
        });

        const repairObjective = `Fix the following test failures in files [${params.target_files.join(', ')}]. \n\nTEST OUTPUT:\n${result.output}`;
        
        // Pass the failure back to the Architect to decide on the fix
        return { success: false, output: `Tests Failed. Instruction for Architect: ${repairObjective}` };
    }
};