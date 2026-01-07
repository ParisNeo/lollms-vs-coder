import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { WorkflowStudioPanel } from '../commands/workflowStudioPanel';
import { WorkflowItem } from '../commands/workflowsTreeProvider';

export function registerWorkflowCommands(context: vscode.ExtensionContext, services: LollmsServices) {
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.openFlowStudio', (item?: WorkflowItem) => {
        WorkflowStudioPanel.createOrShow(services.extensionUri, services.lollmsAPI);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.createNewWorkflow', async () => {
        const name = await vscode.window.showInputBox({ prompt: "Enter workflow name" });
        if (!name) return;
        const wf = services.workflowManager.createNewWorkflow(name);
        await services.workflowManager.saveWorkflow(wf);
        services.treeProviders.workflows?.refresh();
        vscode.window.showInformationMessage(`Created workflow: ${name}`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.deleteWorkflow', async (item: WorkflowItem) => {
        const confirm = await vscode.window.showWarningMessage(`Delete workflow '${item.workflow.name}'?`, { modal: true }, "Delete");
        if (confirm === "Delete") {
            await services.workflowManager.deleteWorkflow(item.workflow.id);
            services.treeProviders.workflows?.refresh();
        }
    }));
}
