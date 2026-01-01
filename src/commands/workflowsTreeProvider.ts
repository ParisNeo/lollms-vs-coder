import * as vscode from 'vscode';
import { WorkflowManager } from '../workflow/workflowManager';
import { Workflow } from '../workflow/types';

export class WorkflowsTreeProvider implements vscode.TreeDataProvider<WorkflowItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<WorkflowItem | undefined | null | void> = new vscode.EventEmitter<WorkflowItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<WorkflowItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private workflowManager: WorkflowManager) {
        this.workflowManager.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: WorkflowItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: WorkflowItem): Promise<WorkflowItem[]> {
        if (element) {
            return [];
        }

        const workflows = await this.workflowManager.getWorkflows();
        return workflows.map(wf => new WorkflowItem(wf));
    }
}

export class WorkflowItem extends vscode.TreeItem {
    constructor(public readonly workflow: Workflow) {
        super(workflow.name, vscode.TreeItemCollapsibleState.None);
        this.id = workflow.id;
        this.contextValue = 'workflow';
        this.iconPath = new vscode.ThemeIcon('type-hierarchy');
        this.tooltip = `ID: ${workflow.id}\nNodes: ${workflow.nodes.length}`;
        
        this.command = {
            command: 'lollms-vs-coder.openFlowStudio',
            title: 'Open Flow Studio',
            arguments: [workflow]
        };
    }
}
