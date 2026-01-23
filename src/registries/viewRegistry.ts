import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { ActionsTreeProvider } from '../commands/actionsTreeProvider';
import { ChatPromptTreeProvider } from '../commands/chatPromptTreeProvider';
import { CodeActionTreeProvider } from '../commands/codeActionTreeProvider';
import { CodeExplorerTreeProvider } from '../commands/codeExplorerTreeProvider';
import { SkillsTreeProvider } from '../commands/skillsTreeProvider';
import { PersonalitiesTreeProvider } from '../commands/personalitiesTreeProvider';
import { WorkflowsTreeProvider } from '../commands/workflowsTreeProvider';
import { DiscussionTreeProvider } from '../commands/discussionTreeProvider';
import { ProcessTreeProvider } from '../commands/processTreeProvider';

export function registerViews(context: vscode.ExtensionContext, services: LollmsServices) {
    // Actions
    const actionsTreeProvider = new ActionsTreeProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsActionsView', actionsTreeProvider));
    
    // Prompts
    const chatPromptTreeProvider = new ChatPromptTreeProvider(services.promptManager);
    services.treeProviders.chatPrompt = chatPromptTreeProvider;
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsChatPromptsView', chatPromptTreeProvider));

    const codeActionTreeProvider = new CodeActionTreeProvider(services.promptManager);
    services.treeProviders.codeAction = codeActionTreeProvider;
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsCodeActionsView', codeActionTreeProvider));

    // Explorer
    const codeExplorerTreeProvider = new CodeExplorerTreeProvider(services.codeGraphManager);
    services.treeProviders.codeExplorer = codeExplorerTreeProvider;
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsCodeExplorerView', codeExplorerTreeProvider));

    // Skills
    const skillsTreeProvider = new SkillsTreeProvider(services.skillsManager);
    services.treeProviders.skills = skillsTreeProvider;
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsSkillsView', skillsTreeProvider));

    // Personalities
    const personalitiesTreeProvider = new PersonalitiesTreeProvider(services.personalityManager);
    services.treeProviders.personalities = personalitiesTreeProvider;
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsPersonalitiesView', personalitiesTreeProvider));

    // Workflows
    const workflowsTreeProvider = new WorkflowsTreeProvider(services.workflowManager);
    services.treeProviders.workflows = workflowsTreeProvider;
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsWorkflowsView', workflowsTreeProvider));

    // Processes
    const processTreeProvider = new ProcessTreeProvider(services.processManager);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsProcessesView', processTreeProvider));

    // Discussions
    const discussionTreeProvider = new DiscussionTreeProvider(services.discussionManager, services.extensionUri);
    services.treeProviders.discussion = discussionTreeProvider;
    
    // Create view specifically for discussions to allow programmatic reveal
    const discussionView = vscode.window.createTreeView('lollmsDiscussionsView', { treeDataProvider: discussionTreeProvider });
    context.subscriptions.push(discussionView);
    
    return discussionView;
}
