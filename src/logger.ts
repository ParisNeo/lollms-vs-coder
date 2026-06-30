import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR'
}

/**
 * Central logger used by the whole extension.
 * Keeps an in‑memory buffer (last 1000 lines) and writes to a file in .lollms directory.
 */
export class Logger {
    private static outputChannel: vscode.OutputChannel;
    /** In‑memory cache of log entries for UI consumption */
    private static _entries: string[] = [];
    private static logFilePath: string | undefined;

    public static initialize(context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('Lollms VS Coder');
        context.subscriptions.push(this.outputChannel);

        // Determine log file path if workspace exists
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const lollmsDir = path.join(root, '.lollms');

            // Asynchronous Directory Creation to keep activation fast and smooth
            fs.promises.mkdir(lollmsDir, { recursive: true }).then(() => {
                this.logFilePath = path.join(lollmsDir, 'lollms_vscode.log');
                this.info(`Logging initialized. Log file: ${this.logFilePath}`);
            }).catch(e => {
                console.error("Failed to initialize log file:", e);
            });
        }
    }

    private static _formatMessage(level: LogLevel, message: string, data?: any): string {
        const timestamp = new Date().toISOString();
        let logMessage = `[${timestamp}] [${level}] ${message}`;

        if (data) {
            if (data instanceof Error) {
                logMessage += `\n${data.stack || data.message}`;
            } else if (typeof data === 'object') {
                try {
                    logMessage += `\n${JSON.stringify(data, null, 2)}`;
                } catch {
                    logMessage += `\n${String(data)}`;
                }
            } else {
                logMessage += ` ${String(data)}`;
            }
        }
        return logMessage;
    }

    private static writeQueue: string[] = [];
    private static isWriting = false;

    private static log(level: LogLevel, message: string, data?: any) {
        const formatted = this._formatMessage(level, message, data);

        if (this.outputChannel) {
            this.outputChannel.appendLine(formatted);
        }

        this._entries.push(formatted);
        if (this._entries.length > 1000) {
            this._entries.shift();
        }

        if (this.logFilePath) {
            this.writeQueue.push(formatted);
            this.flushLogQueue();
        }
    }

    /**
     * Non-blocking asynchronous log flusher.
     * Prevents Extension Host locks by moving disk I/O out of the execution thread.
     */
    private static async flushLogQueue() {
        if (this.isWriting || this.writeQueue.length === 0 || !this.logFilePath) return;
        this.isWriting = true;

        const linesToWrite = [...this.writeQueue];
        this.writeQueue = [];

        try {
            const content = linesToWrite.join('\n') + '\n';
            // Perform non-blocking asynchronous file append
            await fs.promises.appendFile(this.logFilePath, content, 'utf8');
        } catch (e) {
            // Re-queue on failure so logs are not lost
            this.writeQueue.unshift(...linesToWrite);
        } finally {
            this.isWriting = false;
            if (this.writeQueue.length > 0) {
                // Yield to the event loop before continuing writes
                setImmediate(() => this.flushLogQueue());
            }
        }
    }

    public static debug(message: string, data?: any) {
        this.log(LogLevel.DEBUG, message, data);
    }

    public static info(message: string, data?: any) {
        this.log(LogLevel.INFO, message, data);
    }

    public static warn(message: string, data?: any) {
        this.log(LogLevel.WARN, message, data);
    }

    public static error(message: string, data?: any) {
        this.log(LogLevel.ERROR, message, data);
    }

    public static show() {
        this.outputChannel?.show();
    }

    /** Returns the whole in‑memory log as a single string (used by the Settings UI). */
    public static getLogContent(): string {
        return this._entries.join('\n');
    }

    public static getLogFilePath(): string | undefined {
        return this.logFilePath;
    }

    /** 
     * Clears in-memory logs, truncates the physical log file, 
     * and wipes the VS Code Output Channel.
     */
    public static clear() {
        this._entries = [];
        if (this.logFilePath && fs.existsSync(this.logFilePath)) {
            try {
                // Truncate file to 0 bytes
                fs.writeFileSync(this.logFilePath, '');
            } catch (e) {
                console.error("Failed to clear log file:", e);
            }
        }
        if (this.outputChannel) {
            this.outputChannel.clear();
        }
        this.info("System logs cleared by user.");
    }
    }
