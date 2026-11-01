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

        // 1. Run Tests and record to .lollms/last_test_log.log
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const logRelPath = path.join('.lollms', 'last_test_log.log').replace(/\\/g, '/');
        env.agentManager.ui.addMessageToDiscussion({ role: 'system', content: `🧪 **Guardian:** Running test suite: \`${params.test_command}\` (saving to \`${logRelPath}\`)...` });
        const result = await env.agentManager.runCommand(params.test_command, signal);

        if (workspaceFolder) {
            try {
                const logUri = vscode.Uri.joinPath(workspaceFolder.uri, logRelPath);
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, '.lollms')).then(undefined, () => {});
                await vscode.workspace.fs.writeFile(logUri, Buffer.from(result.output || '(No output recorded)', 'utf8'));
                await env.contextManager.getContextStateProvider()?.addFilesToContext([logRelPath]);
                env.contextManager.refreshFileInCache(logUri);
            } catch {}
        }

        if (result.success) {
            return { success: true, output: `✅ Tests passed! Output saved to ${logRelPath}. No fixes required.` };
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