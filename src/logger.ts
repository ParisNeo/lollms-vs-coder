import * as vscode from 'vscode';

export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR'
}

export class Logger {
    private static outputChannel: vscode.OutputChannel;

    public static initialize(context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('Lollms VS Coder');
        context.subscriptions.push(this.outputChannel);
    }

    private static log(level: LogLevel, message: string, data?: any) {
        if (!this.outputChannel) return;

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

        this.outputChannel.appendLine(logMessage);
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
}
