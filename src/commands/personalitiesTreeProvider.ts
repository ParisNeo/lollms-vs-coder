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
            return personalities.map(p => {
                const item = new PersonalityItem(p);
                if (p.icon && p.icon.startsWith('data:image/')) {
                    try {
                        item.iconPath = vscode.Uri.parse(p.icon);
                    } catch {}
                }
                const toolsCount = (p.tools?.length || 0) + (p.extraTools?.length || 0);
                const skillsCount = (p.skills?.length || 0) + (p.extraSkills?.length || 0);
                const extras: string[] = [];
                if (toolsCount > 0) extras.push(`${toolsCount} tool${toolsCount > 1 ? 's' : ''}`);
                if (skillsCount > 0) extras.push(`${skillsCount} skill${skillsCount > 1 ? 's' : ''}`);
                if (extras.length > 0) {
                    item.description = `${p.category || 'General'} · [${extras.join(', ')}]`;
                }
                return item;
            });
        }
        return [];
    }
}
