import * as vscode from 'vscode';
import { LollmsAPI } from './lollmsAPI';
import { ContextManager } from './contextManager';
import { DiscussionManager } from './discussionManager';
import { ProcessManager } from './processManager';
import { PromptManager } from './promptManager';
import { PersonalityManager } from './personalityManager';
import { SkillsManager } from './skillsManager';
import { CodeGraphManager } from './codeGraphManager';
import { NotebookManager } from './notebookTools';
import { GitIntegration } from './gitIntegration';
import { ScriptRunner } from './scriptRunner';
import { QuickEditManager } from './quickEditManager';
import { InlineDiffProvider } from './commands/inlineDiffProvider';
import { WorkflowManager } from './workflow/workflowManager';
import { DiffManager } from './diffManager';
import { HerdManager } from './herdManager';
import { RLMDatabaseManager } from './rlmDatabaseManager';

export interface LollmsServices {
    extensionUri: vscode.Uri;
    lollmsAPI: LollmsAPI;
    contextManager: ContextManager;
    discussionManager: DiscussionManager;
    processManager: ProcessManager;
    promptManager: PromptManager;
    personalityManager: PersonalityManager;
    skillsManager: SkillsManager;
    codeGraphManager: CodeGraphManager;
    notebookManager: NotebookManager;
    gitIntegration: GitIntegration;
    scriptRunner: ScriptRunner;
    quickEditManager: QuickEditManager;
    workflowManager: WorkflowManager;
    inlineDiffProvider: InlineDiffProvider;
    diffManager: DiffManager;
    herdManager: HerdManager;
    rlmDb: RLMDatabaseManager; // Added here
    
    treeProviders: {
        discussion?: any;
        discussionSearch?: any;
        chatPrompt?: any;
        codeAction?: any;
        codeExplorer?: any;
        skills?: any;
        personalities?: any;
        workflows?: any;
    }
}
