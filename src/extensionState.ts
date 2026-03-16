import * as vscode from 'vscode';
import { Logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

export let pythonApi: any = null; 
export let lollmsExecutionTerminal: vscode.Terminal | null = null;


export const debugStateManager = {
    _onDidStop: new vscode.EventEmitter<any>(),
    get onDidStop(): vscode.Event<any> { return this._onDidStop.event; },
    lastState: null as any,
    setStoppedState(state: any) {
        this.lastState = state;
        this._onDidStop.fire(state);
    },
    clearState() {
        this.lastState = null;
    }
};

export const debugErrorManager = {
    _onDidChange: new vscode.EventEmitter<void>(),
    get onDidChange(): vscode.Event<void> { return this._onDidChange.event; },
    lastError: null as { 
        message: string, 
        stack?: string, 
        filePath?: vscode.Uri, 
        line?: number,
        locals?: string // Added to store runtime variable state
    } | null,
    
    setError(message: string, stack?: string, filePath?: vscode.Uri, line?: number, locals?: string) {
        this.lastError = { message, stack, filePath, line, locals };
        vscode.commands.executeCommand('setContext', 'lollms:hasDebugError', true);
        this._onDidChange.fire();
        Logger.info(`Debug error captured: ${message}`, { stack, filePath, line });
    },

    clearError() {
        if (this.lastError === null) return;
        this.lastError = null;
        vscode.commands.executeCommand('setContext', 'lollms:hasDebugError', false);
        this._onDidChange.fire();
    }
};

export function setPythonApi(api: any) {
    pythonApi = api;
}

export function setTerminal(terminal: vscode.Terminal) {
    lollmsExecutionTerminal = terminal;
}

export function disposeTerminal() {
    if (lollmsExecutionTerminal) {
        lollmsExecutionTerminal.dispose();
        lollmsExecutionTerminal = null;
    }
}

/**
 * Executes a command in a visible VS Code terminal via the Task API.
 * Handles PowerShell, CMD, and various Unix shells (Bash, Zsh, Fish).
 */
export async function runCommandInTerminal(
    command: string, 
    cwd: string, 
    taskName: string, 
    signal?: AbortSignal,
    options?: { shell?: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' }
): Promise<{ success: boolean, output: string }> {
    return new Promise(async (resolve) => {
        const outputDir = path.join(cwd, '.lollms');
        // Ensure the directory is clean and exists before every run
        if (!fs.existsSync(outputDir)) {
            try { fs.mkdirSync(outputDir, { recursive: true }); } catch (e) {
                return resolve({ success: false, output: `Failed to create output directory .lollms: ${e}` });
            }
        }

        const outputFile = path.join(outputDir, 'last_output.txt');
        const exitCodeFile = path.join(outputDir, 'last_exit_code.txt');
        
        // Relative paths from cwd
        const relOutputFile = '.lollms/last_output.txt';
        const relExitCodeFile = '.lollms/last_exit_code.txt';

        if (fs.existsSync(outputFile)) { try { fs.unlinkSync(outputFile); } catch(e) {} }
        if (fs.existsSync(exitCodeFile)) { try { fs.unlinkSync(exitCodeFile); } catch(e) {} }

        const isWin = process.platform === 'win32';
        let execution: vscode.ShellExecution;
        const shellType = options?.shell || (isWin ? 'powershell' : 'bash');

        let sanitizedCommand = command;
        // Fix Windows 'curl' alias (Invoke-WebRequest) which breaks standard curl usage
        if (isWin) {
            // Regex to find 'curl' but not 'curl.exe' or 'mycurl'
            sanitizedCommand = sanitizedCommand.replace(/(?<![\w.-])curl(?![\w.-])/g, 'curl.exe');
        }

        if (isWin) {
            if (shellType === 'powershell') {
                // Execute command and capture output manually to ensure we bypass terminal buffer limits
                const psCommand = `& { ${sanitizedCommand} } > "${relOutputFile}" 2>&1; $LASTEXITCODE | Out-File -FilePath "${relExitCodeFile}" -Encoding utf8`;

                execution = new vscode.ShellExecution(
                    "powershell.exe",["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand], 
                    { cwd }
                );
            } else if (shellType === 'cmd') {
                // Force UTF-8 in CMD as well
                const cmdCommand = `chcp 65001 > nul && ${sanitizedCommand} > "${relOutputFile}" 2>&1 & echo %errorlevel% > "${relExitCodeFile}"`;
                execution = new vscode.ShellExecution("cmd.exe", ["/c", cmdCommand], { cwd });
            } else {
                const shCommand = `export LANG=en_US.UTF-8; (${sanitizedCommand}) 2>&1 | tee '${relOutputFile}'; echo $? > '${relExitCodeFile}'`;
                execution = new vscode.ShellExecution("bash.exe", ["-c", shCommand], { cwd });
            }
        } else {
            const targetShell = options?.shell || 'bash';
            const shCommand = `export LANG=en_US.UTF-8; export FORCE_COLOR=1; export TERM=xterm-256color; export CLICOLOR_FORCE=1; (${sanitizedCommand}) 2>&1 | tee "${relOutputFile}"; echo $? > "${relExitCodeFile}"`;
            execution = new vscode.ShellExecution(targetShell, ["-c", shCommand], { cwd });
        }

        const task = new vscode.Task(
            { type: 'lollms-execution' },
            vscode.TaskScope.Workspace,
            taskName,
            'Lollms',
            execution
        );

        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always, // Ensure terminal is shown
            focus: true,                         // Focus the terminal so user sees the command
            panel: vscode.TaskPanelKind.Dedicated,
            showReuseMessage: false,
            clear: true                          // Clear previous output for clarity
        };

        let executionTask: vscode.TaskExecution | undefined;
        
        // 1. Register listener BEFORE executing to ensure we don't miss fast processes
        const disposable = vscode.tasks.onDidEndTaskProcess(e => {
            if (executionTask && e.execution === executionTask) {
                disposable.dispose();
                // Delay reading to ensure the OS has flushed the file buffers to .lollms/
                setTimeout(() => {
                    let output = "";
                    let success = e.exitCode === 0;
                    try {
                        if (fs.existsSync(outputFile)) {
                            output = fs.readFileSync(outputFile, 'utf8').replace(/^\uFEFF/, '');
                        }
                    } catch (err) {
                        output = `[Extension Error] Failed to read terminal output: ${err}`;
                        success = false;
                    }
                    // Strip ANSI codes before returning to the AI agent
                    const { stripAnsiCodes } = require('./utils');
                    resolve({ success, output: stripAnsiCodes(output) });
                }, 800);
            }
        });

        try {
            executionTask = await vscode.tasks.executeTask(task);

            if (signal) {
                signal.addEventListener('abort', () => {
                    executionTask?.terminate();
                    disposable.dispose();
                    resolve({ success: false, output: "Execution cancelled by user." });
                });
            }

            // 2. Safety Timeout: Kill process if it exceeds 2 minutes without finishing
            setTimeout(() => {
                if (executionTask) {
                    executionTask.terminate();
                    disposable.dispose();
                    resolve({ success: false, output: "TIMEOUT: Command took longer than 120s and was terminated." });
                }
            }, 120000);

        } catch (err: any) {
            disposable.dispose();
            resolve({ success: false, output: `Task execution failed: ${err.message}` });
        }
    });
}
