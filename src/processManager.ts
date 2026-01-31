import * as vscode from 'vscode';
import { Logger } from './logger';

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
        Logger.info(`[ProcessManager] Registered process: ${id} (${description}) for discussion: ${discussionId}`);
        this._onDidProcessChange.fire();
        return process;
    }

    public unregister(id: string): void {
        if (this.processes.has(id)) {
            this.processes.delete(id);
            Logger.info(`[ProcessManager] Unregistered process: ${id}`);
            this._onDidProcessChange.fire();
        }
    }

    public async cancel(id: string): Promise<void> {
        const process = this.processes.get(id);
        if (process) {
            Logger.info(`[ProcessManager] Cancelling process: ${id}`);
            process.controller.abort();
            // Small delay to ensure listeners react to abort signal before removing from UI
            await new Promise(resolve => setTimeout(resolve, 50));
            this.unregister(id);
        } else {
            Logger.warn(`[ProcessManager] Cannot cancel process ${id}: Not found.`);
        }
    }

    public async cancelForDiscussion(discussionId: string): Promise<void> {
        Logger.info(`[ProcessManager] Cancelling all processes for discussion: ${discussionId}`);
        const processesToCancel = Array.from(this.processes.values()).filter(p => p.discussionId === discussionId);
        for (const process of processesToCancel) {
            await this.cancel(process.id);
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
