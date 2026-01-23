import * as vscode from 'vscode';
import { Logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

export let pythonApi: any = null; 
export let lollmsExecutionTerminal: vscode.Terminal | null = null;

export const debugErrorManager = {
    _onDidChange: new vscode.EventEmitter<void>(),
    get onDidChange(): vscode.Event<void> { return this._onDidChange.event; },
    lastError: null as { message: string, stack?: string, filePath?: vscode.Uri, line?: number } | null,
    
    setError(message: string, stack?: string, filePath?: vscode.Uri, line?: number) {
        this.lastError = { message, stack, filePath, line };
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
 * This allows the user to see output in real-time and stop the process manually.
 */
export async function runCommandInTerminal(
    command: string, 
    cwd: string, 
    taskName: string, 
    signal?: AbortSignal
): Promise<{ success: boolean, output: string }> {
    return new Promise(async (resolve) => {
        const outputDir = path.join(cwd, '.lollms');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const outputFile = path.join(outputDir, 'last_output.txt');
        const exitCodeFile = path.join(outputDir, 'last_exit_code.txt');

        // Cleanup old results
        if (fs.existsSync(outputFile)) { 
            try { fs.unlinkSync(outputFile); } catch(e) {}
        }
        if (fs.existsSync(exitCodeFile)) { 
            try { fs.unlinkSync(exitCodeFile); } catch(e) {}
        }

        const isWin = process.platform === 'win32';
        let execution: vscode.ShellExecution;

        if (isWin) {
            // CRITICAL FIX: 
            // 1. Force PowerShell to output UTF8 to file to fix garbage characters (OEM/CP850 issues).
            // 2. Wrap command to capture exit code correctly.
            const psCommand = `
                $OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
                & { ${command} } | Tee-Object -FilePath "${outputFile}";
                $LASTEXITCODE | Out-File -FilePath "${exitCodeFile}" -Encoding utf8
            `.trim().replace(/\n/g, ' ');
            
            execution = new vscode.ShellExecution("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand], { cwd });
        } else {
            // Bash style
            const shCommand = `(${command}) 2>&1 | tee "${outputFile}"; echo $? > "${exitCodeFile}"`;
            execution = new vscode.ShellExecution(shCommand, { cwd });
        }

        const task = new vscode.Task(
            { type: 'lollms-execution' },
            vscode.TaskScope.Workspace,
            taskName,
            'Lollms',
            execution
        );

        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            focus: true,
            panel: vscode.TaskPanelKind.Dedicated,
            showReuseMessage: false,
            clear: true
        };

        const executionTask = await vscode.tasks.executeTask(task);

        const disposable = vscode.tasks.onDidEndTaskProcess(e => {
            if (e.execution === executionTask) {
                disposable.dispose();
                
                // Small delay to ensure files are flushed to disk
                setTimeout(() => {
                    let output = "";
                    let success = true;
                    try {
                        if (fs.existsSync(outputFile)) {
                            output = fs.readFileSync(outputFile, 'utf8');
                        }
                        if (fs.existsSync(exitCodeFile)) {
                            const code = fs.readFileSync(exitCodeFile, 'utf8').trim().replace(/^\uFEFF/, '');
                            success = code === '0';
                        } else {
                            success = e.exitCode === 0;
                        }
                    } catch (err) {
                        output = `Error reading task results: ${err}`;
                        success = false;
                    }
                    resolve({ success, output });
                }, 500);
            }
        });

        if (signal) {
            signal.addEventListener('abort', () => {
                executionTask.terminate();
                disposable.dispose();
                resolve({ success: false, output: "Execution cancelled." });
            });
        }
    });
}
