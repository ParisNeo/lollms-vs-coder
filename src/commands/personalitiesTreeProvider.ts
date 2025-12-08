import * as vscode from 'vscode';
import { PersonalityManager } from '../personalityManager';
import { PersonalityItem } from './treeItems';

export class PersonalitiesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private personalityManager: PersonalityManager) {
        this.personalityManager.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            const personalities = this.personalityManager.getPersonalities();
            return personalities.map(p => new PersonalityItem(p));
        }
        return [];
    }
}
