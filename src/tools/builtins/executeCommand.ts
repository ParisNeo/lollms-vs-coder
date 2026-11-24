import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { Logger } from '../../logger';
import { AgentSecurityGuard } from '../../security/agentSecurityGuard';
import { ContextPoisoningGate } from '../../security/contextPoisoningGate';

export const executeCommandTool: ToolDefinition = {
    name: "execute_command",
    description: "Executes a shell command in the workspace root.",
    isAgentic: false,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters: [
        { name: "command", type: "string", description: "The shell command to execute.", required: true },
        { name: "shell", type: "string", description: "Optional: 'powershell', 'cmd', or 'bash'. Defaults to system default.", required: false },
        { name: "timeout_s", type: "number", description: "Optional: Execution timeout in seconds. Default is 900s (15 minutes). Use higher values for long tasks like downloading or training.", required: false }
        ],
    manualTagFormat: `<edit_image_asset width="1280" height="720"><input_file>path</input_file><prompt>...</prompt><output_file>path</output_file></edit_image_asset>`,
        async execute(params: { command: string, shell?: string, timeout_s?: number }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.command) {
            return { success: false, output: "Error: 'command' parameter is required." };
        }
        if (!env.agentManager) {
            return { success: false, output: "Error: Agent capabilities not available." };
        }

        const isBuilder = env.agentManager.getCurrentDiscussion()?.capabilities?.workerType === 'builder';
        if (isBuilder) {
            return { 
                success: false, 
                output: "🛑 SECURITY ERROR: The 'Builder' agent is forbidden from executing shell commands autonomously. You MUST use 'delegate_to_user' to ask the human to run this command for you." 
            };
        }

        const timeoutMs = params.timeout_s ? params.timeout_s * 1000 : 900000; // 15 minute default

        // --- 🛡️ DETERMINISTIC + LLM SECURITY AUDIT ---
        const workspaceRoots = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        if (env.workspaceRoot && !workspaceRoots.includes(env.workspaceRoot.uri.fsPath)) {
            workspaceRoots.unshift(env.workspaceRoot.uri.fsPath);
        }
        const secLevel = env.agentManager?.getSecurityLevel?.() || 'guarded';
        const staticRes = AgentSecurityGuard.analyzeShellCommand(params.command, secLevel, workspaceRoots);
        if (staticRes.decision === 'block') {
            Logger.error(`[SECURITY HARD-BLOCK] Command: ${params.command}. Reason: ${staticRes.reason}`);
            return {
                success: false,
                output: `🛑 SECURITY VIOLATION: Execution blocked deterministically.\nReason: ${staticRes.reason}`
            };
        }

        // If invoking a script file in the workspace, validate & scan its content too
        const scriptMatch = params.command.match(/\b(?:python3?|node|bash|sh|pwsh|powershell)\s+([^\r\n;&|]+\.(?:py|js|mjs|cjs|ts|sh|ps1))\b/i);
        if (scriptMatch) {
            const scriptTarget = scriptMatch[1].trim().replace(/^['"]|['"]$/g, '');
            const pathCheck = AgentSecurityGuard.validateWorkspacePath(scriptTarget, env.workspaceRoot);
            if (!pathCheck.valid) {
                return { success: false, output: `🛑 SECURITY VIOLATION: ${pathCheck.reason}` };
            }
            const resolved = await env.contextManager?.resolveWorkspaceFromPath?.(scriptTarget);
            if (resolved) {
                try {
                    const bytes = await vscode.workspace.fs.readFile(resolved.uri);
                    const scriptScan = AgentSecurityGuard.analyzeScriptContent(Buffer.from(bytes).toString('utf8'), resolved.relativePath, secLevel, workspaceRoots);
                    if (scriptScan.decision === 'block') {
                        return { success: false, output: `🛑 SECURITY VIOLATION: ${scriptScan.reason}` };
                    }
                    if (scriptScan.decision === 'confirm') {
                        const approval = await env.agentManager.requestSecurityApproval(
                            `Confirm Script Execution: ${resolved.relativePath}`,
                            `${scriptScan.reason}`,
                            'execute_command',
                            resolved.relativePath,
                            signal
                        );
                        if (approval === 'block') {
                            return { success: false, output: `🛑 SECURITY BLOCK: Script execution rejected by user.` };
                        }
                    }
                } catch {}
            }
        }

        const audit = await (env.agentManager as any).performSecurityAudit(params.command, signal);
        if (!audit.safe) {
            Logger.error(`[SECURITY BLOCK] Command: ${params.command}. Reason: ${audit.reason}`);
            return { 
                success: false, 
                output: `🛑 SECURITY VIOLATION: Execution blocked by Sovereign Auditor.\nReason: ${audit.reason}` 
            };
        }

        // MITIGATION: Prevent the agent from accidentally staging internal extension files
        if (params.command === "workbench.action.reloadWindow") {
            await vscode.commands.executeCommand(params.command);
            return { success: true, output: "Window reload triggered." };
        }

        const result = await (env.agentManager as any).runCommand(params.command, signal, { shell: params.shell, timeoutMs });
        if (params.command.includes("git add") && !params.command.includes(".gitignore")) {
            result.output += "\n[SYSTEM ADVICE]: You are using 'git add'. Ensure you have a proper .gitignore to avoid staging internal folders like .lollms/ or venv/.";
        }

        const gateRes = await ContextPoisoningGate.sanitizeExecutionOutput(result.output || '', 'execute_command', { signal });
        return {
            success: result.success && !gateRes.blocked,
            output: gateRes.sanitizedOutput
        };
        }
};
