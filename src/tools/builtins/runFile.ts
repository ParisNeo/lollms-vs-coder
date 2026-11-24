import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { AgentSecurityGuard } from '../../security/agentSecurityGuard';
import { ContextPoisoningGate } from '../../security/contextPoisoningGate';
import * as path from 'path';

export const runFileTool: ToolDefinition = {
    name: "run_file",
    description: "Executes a file in the workspace using the appropriate interpreter based on its extension. Returns stdout and stderr for verification.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters:[
        { name: "file_path", type: "string", description: "Relative path to the file to execute.", required: true },
        { name: "args", type: "string", description: "Optional command line arguments to pass to the script.", required: false },
        { name: "timeout_s", type: "number", description: "Optional: Execution timeout in seconds. Default is 900s (15 minutes). For training scripts, set to 3600+.", required: false }
        ],
        async execute(params: { file_path: string, args?: string, timeout_s?: number }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }
        if (!env.agentManager) {
             return { success: false, output: "Error: Agent capabilities not available." };
        }

        const isBuilder = env.agentManager.getCurrentDiscussion()?.capabilities?.workerType === 'builder';
        if (isBuilder) {
            return {
                success: false,
                output: "🛑 SECURITY ERROR: The 'Builder' agent is forbidden from executing files autonomously."
            };
        }

        const filePath = params.file_path;
        const pathCheck = AgentSecurityGuard.validateWorkspacePath(filePath, env.workspaceRoot);
        if (!pathCheck.valid) {
            return { success: false, output: `🛑 SECURITY VIOLATION: ${pathCheck.reason}` };
        }

        const workspaceRoots = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        if (!workspaceRoots.includes(env.workspaceRoot.uri.fsPath)) {
            workspaceRoots.unshift(env.workspaceRoot.uri.fsPath);
        }
        const secLevel = env.agentManager.getSecurityLevel?.() || 'guarded';

        if (params.args) {
            const argsCheck = AgentSecurityGuard.analyzeShellCommand(params.args, secLevel, workspaceRoots);
            if (argsCheck.decision === 'block') {
                return { success: false, output: `🛑 SECURITY VIOLATION in args: ${argsCheck.reason}` };
            }
        }

        const resolved = await env.contextManager?.resolveWorkspaceFromPath?.(filePath);
        const targetUri = resolved?.uri || (path.isAbsolute(filePath) ? vscode.Uri.file(filePath) : vscode.Uri.joinPath(env.workspaceRoot.uri, filePath));
        try {
            const bytes = await vscode.workspace.fs.readFile(targetUri);
            const scriptContent = Buffer.from(bytes).toString('utf8');
            const scan = AgentSecurityGuard.analyzeScriptContent(scriptContent, filePath, secLevel, workspaceRoots);
            if (scan.decision === 'block') {
                return { success: false, output: `🛑 SECURITY VIOLATION: ${scan.reason}` };
            }
            if (scan.decision === 'confirm') {
                const detail = scan.matchedLines.length > 0
                    ? `${scan.reason}\n\nFlagged lines:\n${scan.matchedLines.slice(0, 8).join('\n')}`
                    : scan.reason;
                const decision = await env.agentManager.requestSecurityApproval(
                    `Authorize File Execution: ${filePath}`,
                    detail,
                    'run_file',
                    filePath,
                    signal
                );
                if (decision === 'block') {
                    return { success: false, output: `🛑 Execution of '${filePath}' was denied by the user.` };
                }
            }
        } catch (err: any) {
            return { success: false, output: `🛑 Error: Cannot read '${filePath}' inside workspace: ${err?.message || err}` };
        }

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
        const timeoutMs = params.timeout_s ? params.timeout_s * 1000 : 900000; // 15 minute default
        const runRes = await env.agentManager.runCommand(command, signal, { timeoutMs });
        const gateRes = await ContextPoisoningGate.sanitizeExecutionOutput(runRes.output || '', `run_file://${filePath}`, { signal });
        return {
            success: runRes.success && !gateRes.blocked,
            output: gateRes.sanitizedOutput
        };
    }
};
