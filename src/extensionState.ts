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
    options?: { 
        shell?: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish',
        timeoutMs?: number 
    }
): Promise<{ success: boolean, output: string }> {
    return new Promise(async (resolve) => {
        const outputDir = path.join(cwd, '.lollms');
        // Ensure the directory is clean and exists before every run
        if (!fs.existsSync(outputDir)) {
            try { fs.mkdirSync(outputDir, { recursive: true }); } catch (e) {
                return resolve({ success: false, output: `Failed to create output directory .lollms: ${e}` });
            }
        }

        // Generate a unique ID for this specific execution to prevent race conditions in parallel tasks
        const executionId = Math.random().toString(36).substring(2, 10);
        const outputFile = path.join(outputDir, `output_${executionId}.txt`);
        const exitCodeFile = path.join(outputDir, `exit_code_${executionId}.txt`);
        
        // Relative paths from cwd for use in the shell command
        const relOutputFile = `.lollms/output_${executionId}.txt`;
        const relExitCodeFile = `.lollms/exit_code_${executionId}.txt`;

        if (fs.existsSync(outputFile)) { try { fs.unlinkSync(outputFile); } catch(e) {} }
        if (fs.existsSync(exitCodeFile)) { try { fs.unlinkSync(exitCodeFile); } catch(e) {} }

        const isWin = process.platform === 'win32';
        let execution: vscode.ShellExecution;

        // Load .env variables dynamically and FORCE UTF-8 for Python/System
        let envVars: Record<string, string> = {
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "LANG": "en_US.UTF-8"
        };
        try {
            const envPath = path.join(cwd, '.lollms', '.env');
            const content = await fs.readFileSync(envPath, 'utf8');
            content.split('\n').forEach(line => {
                const [k, ...v] = line.split('=');
                if (k) envVars[k.trim()] = v.join('=').trim();
            });
        } catch {}

        let sanitizedCommand = command;
        if (isWin) {
            sanitizedCommand = sanitizedCommand.replace(/(?<![\w.-])curl(?![\w.-])/g, 'curl.exe');
        }

        let batFileToCleanup: string | null = null;

        if (isWin) {
            // ROBUST WINDOWS EXECUTION:
            // Write the exact command to a temporary .bat file. 
            // This natively bypasses PowerShell's strict quote/string parsing and && syntax errors.
            // We execute the .bat file inside PowerShell purely to capture live output via Tee-Object.
            const batFile = path.join(outputDir, `run_${executionId}.bat`);
            const relBatFile = `.lollms\\run_${executionId}.bat`;
            
            const envSetters = Object.entries(envVars).map(([k, v]) => `set ${k}=${v}`).join('\n');
            const batContent = `@echo off\nchcp 65001 >nul\n${envSetters}\n${sanitizedCommand}`;
            fs.writeFileSync(batFile, batContent);
            batFileToCleanup = batFile;

            const utf8Setup = `[Console]::InputEncoding = [Console]::OutputEncoding =[System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8;`;
            const psCommand = `${utf8Setup} & "${batFile}" 2>&1 | Tee-Object -FilePath "${relOutputFile}"; $LASTEXITCODE | Out-File -FilePath "${relExitCodeFile}" -Encoding utf8`;
            execution = new vscode.ShellExecution("powershell.exe",["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand], { cwd });
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
                // Small delay to allow GUI apps to flush final logs to file
                setTimeout(() => {
                    let output = "";
                    let success = e.exitCode === 0 || e.exitCode === 1; // UI apps often exit with 1 on manual close
                    try {
                        if (fs.existsSync(outputFile)) {
                            const buffer = fs.readFileSync(outputFile);

                            if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
                                output = buffer.toString('utf16le');
                            } 
                            else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
                                output = buffer.swap16().toString('utf16le');
                            } 
                            else {
                                // Default to UTF-8 with manual normalization
                                // We use TextDecoder with fatal:false to replace bad sequences with placeholders
                                const decoder = new TextDecoder('utf-8', { fatal: false });
                                output = decoder.decode(buffer);
                            }

                            output = output.replace(/^\uFEFF/, '');
                            output = output.replace(/\0/g, '');

                            if (output.trim() === '') {
                                output = "[Command completed with no output]";
                            }
                        } else {
                            output = "[Command failed to execute. Check syntax (e.g. do not use && in PowerShell).]";
                            success = false; // Force failure if output piping didn't even run
                        }
                    } catch (err) {
                        output = `[Extension Error] Failed to read terminal output: ${err}`;
                        success = false;
                    }
                    // Cleanup: Remove the temporary files immediately after reading
                    try {
                        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
                        if (fs.existsSync(exitCodeFile)) fs.unlinkSync(exitCodeFile);
                        if (batFileToCleanup && fs.existsSync(batFileToCleanup)) fs.unlinkSync(batFileToCleanup);
                    } catch (e: any) {
                        Logger.warn(`Failed to cleanup temp terminal files: ${e.message}`);
                    }

                    // Strip ANSI codes from the output before returning to the AI agent
                    const { stripAnsiCodes } = require('./utils');
                    resolve({ success, output: stripAnsiCodes(output) });
                }, 800);
            }
        });

        try {
            executionTask = await vscode.tasks.executeTask(task);

            // If the task failed to even start (invalid shell, missing binary)
            if (!executionTask) {
                return resolve({ success: false, output: "OS ERROR: Task execution failed to initialize. Verify your terminal settings." });
            }

            if (signal) {
                signal.addEventListener('abort', () => {
                    executionTask?.terminate();
                    disposable.dispose();
                    resolve({ success: false, output: "Execution cancelled by user." });
                });
            }

            // 2. Safety Timeout: Configurable by the Agent. Default to 120s if not specified.
            const timeoutDuration = options?.timeoutMs || 120000;
            setTimeout(() => {
                if (executionTask) {
                    executionTask.terminate();
                    disposable.dispose();
                    const seconds = Math.floor(timeoutDuration / 1000);
                    resolve({ success: false, output: `TIMEOUT: Command took longer than ${seconds}s and was terminated. Hint: Increase the 'timeout_s' parameter for heavy tasks.` });
                }
            }, timeoutDuration);

        } catch (err: any) {
            disposable.dispose();
            resolve({ success: false, output: `Task execution failed: ${err.message}` });
        }
    });
}
