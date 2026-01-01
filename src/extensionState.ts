import * as vscode from 'vscode';
import { Logger } from './logger';

export let pythonExtApi: any = null; 
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
    pythonExtApi = api;
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
