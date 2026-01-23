import * as vscode from 'vscode';
import { ProcessManager, RunningProcess } from '../processManager';
import { ProcessItem } from './treeItems';

export class ProcessTreeProvider implements vscode.TreeDataProvider<ProcessItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ProcessItem | undefined | null | void> = new vscode.EventEmitter<ProcessItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ProcessItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private processManager: ProcessManager) {
        this.processManager.onDidProcessChange(() => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ProcessItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ProcessItem): Promise<ProcessItem[]> {
        if (element) {
            return [];
        }

        const processes = this.processManager.getAll();
        if (processes.length === 0) {
            return [];
        }

        return processes.map(p => new ProcessItem(p));
    }
}
