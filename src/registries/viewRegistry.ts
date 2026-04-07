import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { ActionsTreeProvider } from '../commands/actionsTreeProvider';
import { ChatPromptTreeProvider } from '../commands/chatPromptTreeProvider';
import { CodeActionTreeProvider } from '../commands/codeActionTreeProvider';
import { CodeExplorerTreeProvider } from '../commands/codeExplorerTreeProvider';
import { SkillsTreeProvider } from '../commands/skillsTreeProvider';
import { PersonalitiesTreeProvider } from '../commands/personalitiesTreeProvider';
import { WorkflowsTreeProvider } from '../commands/workflowsTreeProvider';
import { DiscussionTreeProvider, DiscussionSearchProvider } from '../commands/discussionTreeProvider';
import { ProcessTreeProvider } from '../commands/processTreeProvider';

export class TabsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) {}

    refresh() { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<vscode.TreeItem[]> {
        const activeTab = this.context.globalState.get('lollms.activeTab', 'chat');
        const { TabItem } = require('../commands/treeItems');
        
        return [
            new TabItem("Chat & Discussions", "chat", "comment-discussion", activeTab === 'chat'),
            new TabItem("Librarian (Knowledge)", "librarian", "library", activeTab === 'librarian'),
            new TabItem("Git Manager", "git", "git-merge", activeTab === 'git'),
            new TabItem("Architecture Graph", "graph", "graph", activeTab === 'graph'),
            new TabItem("The Lab (Workflows/Tools)", "lab", "beaker", activeTab === 'lab')
        ];
    }
}

export function registerViews(context: vscode.ExtensionContext, services: LollmsServices) {
    // Tabs
    const tabsProvider = new TabsTreeProvider(context);
    services.treeProviders.tabs = tabsProvider;
    context.subscriptions.push(vscode.window.registerTreeDataProvider('lollmsTabsView', tabsProvider));

    // Actions
    const actionsTreeProvider = new ActionsTreeProvider();
    services.treeProviders.actions = actionsTreeProvider;
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
    
    const discussionView = vscode.window.createTreeView('lollmsDiscussionsView', { treeDataProvider: discussionTreeProvider });
    context.subscriptions.push(discussionView);

   
    return discussionView;
}
