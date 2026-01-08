import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { registerUICommands } from './uiCommands';
import { registerChatCommands } from './chatCommands';
import { registerContextCommands } from './contextCommands';
import { registerFileCommands } from './fileCommands';
import { registerPromptCommands } from './promptCommands';
import { registerDebugCommands } from './debugCommands';
import { registerWorkflowCommands } from './workflowCommands';
import { registerNotebookCommands } from './notebookCommands';
import { registerTitleAllDiscussions } from '../commands/titleAllDiscussions';
import { registerGitCommands } from './gitCommands';

export function registerCommands(
    context: vscode.ExtensionContext,
    services: LollmsServices,
    getActiveWorkspace: () => vscode.WorkspaceFolder | undefined
) {
    registerUICommands(context, services);
    registerChatCommands(context, services, getActiveWorkspace);
    registerContextCommands(context, services);
    registerFileCommands(context, services, getActiveWorkspace);
    registerPromptCommands(context, services);
    registerDebugCommands(context, services, getActiveWorkspace);
    registerWorkflowCommands(context, services);
    registerNotebookCommands(context, services);
    registerGitCommands(context, services, getActiveWorkspace);
    registerTitleAllDiscussions(context, services.discussionManager);
}
