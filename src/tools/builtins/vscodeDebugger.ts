import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { debugStateManager } from '../../extensionState';

export const vscodeDebuggerTool: ToolDefinition = {
    name: "vscode_debugger",
    description: "Controls the VS Code debugger. Can set breakpoints, start a debug session, step through code, and inspect variables. Use this for deep autonomous debugging.",
    isAgentic: true,
    isDefault: true,
    parameters:[
        { name: "action", type: "string", description: "The action to perform: 'set_breakpoints', 'start', 'step_over', 'step_into', 'step_out', 'continue', 'stop', 'get_state'", required: true },
        { name: "file_path", type: "string", description: "Required for 'set_breakpoints' and 'start' (if no config specified). The file to debug or set breakpoints in.", required: false },
        { name: "lines", type: "array", description: "Required for 'set_breakpoints'. Array of line numbers.", required: false },
        { name: "config_name", type: "string", description: "Optional for 'start'. The name of the launch configuration from launch.json to run.", required: false }
    ],
    async execute(params: { action: string, file_path?: string, lines?: number[], config_name?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) {
            return { success: false, output: "No workspace folder found." };
        }

        const waitForStop = (): Promise<string> => {
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    disposable.dispose();
                    termDisposable.dispose();
                    resolve("Timeout waiting for debugger to stop. It might still be running or has finished.");
                }, 15000);

                const disposable = debugStateManager.onDidStop((state) => {
                    clearTimeout(timeout);
                    disposable.dispose();
                    termDisposable.dispose();
                    let output = `Debugger Stopped (Reason: ${state.reason})\nLocation: ${state.location}\n\n`;
                    if (state.locals) {
                        output += `Variables:\n${state.locals}\n`;
                    }
                    resolve(output);
                });

                const termDisposable = vscode.debug.onDidTerminateDebugSession(() => {
                    clearTimeout(timeout);
                    disposable.dispose();
                    termDisposable.dispose();
                    resolve("Debug session terminated.");
                });
            });
        };

        try {
            switch (params.action) {
                case 'set_breakpoints':
                    if (!params.file_path || !params.lines) return { success: false, output: "file_path and lines are required." };
                    const uri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);
                    const bps = params.lines.map(l => new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(l - 1, 0))));
                    vscode.debug.addBreakpoints(bps);
                    return { success: true, output: `Set ${bps.length} breakpoints in ${params.file_path}.` };

                case 'start':
                    const waitStart = waitForStop();
                    if (params.config_name) {
                        await vscode.debug.startDebugging(env.workspaceRoot, params.config_name);
                    } else if (params.file_path) {
                        const fileUri = vscode.Uri.joinPath(env.workspaceRoot.uri, params.file_path);
                        await vscode.debug.startDebugging(env.workspaceRoot, {
                            type: params.file_path.endsWith('.py') ? 'python' : (params.file_path.endsWith('.js') || params.file_path.endsWith('.ts') ? 'node' : 'cppdbg'),
                            request: 'launch',
                            name: `Debug ${params.file_path}`,
                            program: fileUri.fsPath,
                            console: 'integratedTerminal'
                        });
                    } else {
                        return { success: false, output: "Requires file_path or config_name." };
                    }
                    const startRes = await waitStart;
                    return { success: true, output: startRes };

                case 'step_over':
                    const waitOver = waitForStop();
                    await vscode.commands.executeCommand('workbench.action.debug.stepOver');
                    return { success: true, output: await waitOver };

                case 'step_into':
                    const waitInto = waitForStop();
                    await vscode.commands.executeCommand('workbench.action.debug.stepInto');
                    return { success: true, output: await waitInto };

                case 'step_out':
                    const waitOut = waitForStop();
                    await vscode.commands.executeCommand('workbench.action.debug.stepOut');
                    return { success: true, output: await waitOut };

                case 'continue':
                    const waitCont = waitForStop();
                    await vscode.commands.executeCommand('workbench.action.debug.continue');
                    return { success: true, output: await waitCont };

                case 'stop':
                    await vscode.commands.executeCommand('workbench.action.debug.stop');
                    return { success: true, output: "Debugger stopped." };

                case 'get_state':
                    if (!vscode.debug.activeDebugSession) {
                        return { success: false, output: "No active debug session." };
                    }
                    const state = debugStateManager.lastState;
                    if (state) {
                        let out = `Location: ${state.location}\nReason: ${state.reason}\nVariables:\n${state.locals}`;
                        return { success: true, output: out };
                    }
                    return { success: false, output: "State unknown. Try stepping." };

                default:
                    return { success: false, output: `Unknown action: ${params.action}` };
            }
        } catch (e: any) {
            return { success: false, output: `Debugger tool error: ${e.message}` };
        }
    }
};