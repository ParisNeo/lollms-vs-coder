import * as vscode from 'vscode';
import { ProcessManager } from '../processManager';
import { ProcessItem } from './treeItems';

export class ProcessTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private processManager: ProcessManager) {
        this.processManager.onDidProcessChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            const processes = this.processManager.getAll();
            return Promise.resolve(processes.map(p => new ProcessItem(p)));
        }
        return Promise.resolve([]);
    }
}