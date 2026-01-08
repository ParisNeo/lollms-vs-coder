import * as vscode from 'vscode';

export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR'
}

/**
 * Central logger used by the whole extension.
 * Keeps an in‑memory buffer (last 500 lines) that the Settings UI can display.
 */
export class Logger {
    private static outputChannel: vscode.OutputChannel;
    /** In‑memory cache of log entries for UI consumption */
    private static _entries: string[] = [];

    public static initialize(context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('Lollms VS Coder');
        context.subscriptions.push(this.outputChannel);
    }

    private static _formatMessage(level: LogLevel, message: string, data?: any): string {
        const timestamp = new Date().toLocaleTimeString();
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

    private static log(level: LogLevel, message: string, data?: any) {
        if (!this.outputChannel) return;

        const formatted = this._formatMessage(level, message, data);
        this.outputChannel.appendLine(formatted);

        // Keep a bounded in‑memory history (last 500 lines)
        this._entries.push(formatted);
        if (this._entries.length > 500) {
            this._entries.shift();
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
}
