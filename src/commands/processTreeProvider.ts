import * as vscode from 'vscode';
import { ProcessManager } from '../processManager';
import { ProcessItem } from './treeItems';

export class ProcessTreeProvider implements vscode.TreeDataProvider<ProcessItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ProcessItem | undefined | null | void> = new vscode.EventEmitter<ProcessItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ProcessItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private processManager: ProcessManager) {
        this.processManager.onDidChangeProcesses(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ProcessItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ProcessItem): Thenable<ProcessItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        const processes = this.processManager.getAll();
        return Promise.resolve(processes.map(p => new ProcessItem(p)));
    }
}