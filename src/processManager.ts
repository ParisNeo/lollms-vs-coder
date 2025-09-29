import * as vscode from 'vscode';

export interface RunningProcess {
    id: string;
    discussionId: string;
    description: string;
    startTime: number;
    controller: AbortController;
}

export class ProcessManager {
    private processes: Map<string, RunningProcess> = new Map();
    private readonly _onDidProcessChange = new vscode.EventEmitter<void>();
    public readonly onDidProcessChange: vscode.Event<void> = this._onDidProcessChange.event;

    public register(discussionId: string, description: string): RunningProcess {
        const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const controller = new AbortController();
        const process: RunningProcess = {
            id,
            discussionId,
            description,
            startTime: Date.now(),
            controller
        };
        this.processes.set(id, process);
        console.log(`[ProcessManager] Registered process ${id} for discussion ${discussionId}`);
        this._onDidProcessChange.fire();
        return process;
    }

    public unregister(id: string): void {
        if (this.processes.has(id)) {
            this.processes.delete(id);
            console.log(`[ProcessManager] Unregistered process ${id}`);
            this._onDidProcessChange.fire();
        }
    }

    public cancel(id: string): void {
        const process = this.processes.get(id);
        if (process) {
            process.controller.abort();
            // The process will be unregistered in the 'finally' block of the API call
        }
    }

    public cancelForDiscussion(discussionId: string): void {
        for (const process of this.processes.values()) {
            if (process.discussionId === discussionId) {
                this.cancel(process.id);
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

    public getAll(): RunningProcess[] {
        return Array.from(this.processes.values());
    }
}