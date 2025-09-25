import * as vscode from 'vscode';

export interface RunningProcess {
    id: string;
    discussionId: string;
    description: string;
    controller: AbortController;
    startTime: number;
}

export class ProcessManager {
    private processes: Map<string, RunningProcess> = new Map();
    private _onDidChangeProcesses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onDidChangeProcesses: vscode.Event<void> = this._onDidChangeProcesses.event;

    public register(discussionId: string, description: string): { id: string, controller: AbortController } {
        const id = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
        const controller = new AbortController();
        const process: RunningProcess = {
            id,
            discussionId,
            description,
            controller,
            startTime: Date.now()
        };
        this.processes.set(id, process);
        this._onDidChangeProcesses.fire();
        console.log(`[ProcessManager] Registered process ${id} for discussion ${discussionId}`);
        return { id, controller };
    }

    public unregister(id: string): void {
        if (this.processes.has(id)) {
            this.processes.delete(id);
            this._onDidChangeProcesses.fire();
            console.log(`[ProcessManager] Unregistered process ${id}`);
        }
    }

    public cancel(id: string): void {
        const process = this.processes.get(id);
        if (process) {
            console.log(`[ProcessManager] Cancelling process ${id}`);
            process.controller.abort();
            // The process should unregister itself in a finally block.
            // But we can also remove it here to be safe.
            this.unregister(id);
        }
    }

    public cancelForDiscussion(discussionId: string): void {
        for (const [id, process] of this.processes.entries()) {
            if (process.discussionId === discussionId) {
                this.cancel(id);
            }
        }
    }

    public getForDiscussion(discussionId: string): RunningProcess | undefined {
        for (const process of this.processes.values()) {
            if (process.discussionId === discussionId) {
                return process;
            }
        }
        return undefined;
    }
    
    public get(id: string): RunningProcess | undefined {
        return this.processes.get(id);
    }

    public getAll(): RunningProcess[] {
        return Array.from(this.processes.values());
    }
}