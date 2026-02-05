import * as vscode from 'vscode';
import { LollmsAPI } from '../lollmsAPI';
import { ContextManager } from '../contextManager';
import type { AgentManager } from '../agentManager';
import type { CodeGraphManager } from '../codeGraphManager';
import { SkillsManager } from '../skillsManager';

export interface Plan {
    objective: string;
    scratchpad: string;
    tasks: any[];
    investigation?: any[]; // Stores architect investigation steps
    attempts?: Plan[];     // Historical versions of the plan after replanning
    status?: 'active' | 'stale' | 'failed'; 
}

export interface ToolExecutionEnv {
    workspaceRoot?: vscode.WorkspaceFolder;
    lollmsApi: LollmsAPI;
    contextManager: ContextManager;
    codeGraphManager?: CodeGraphManager;
    skillsManager?: SkillsManager;
    currentPlan: Plan | null;
    agentManager?: AgentManager; // Made optional for Companion use
}

/**
 * Permission groups used for global security settings.
 */
export type ToolPermissionGroup = 'shell_execution' | 'filesystem_write' | 'filesystem_read' | 'internet_access';

export interface ToolDefinition {
    name: string;
    description: string;
    longDescription?: string;
    isAgentic: boolean;
    isDefault: boolean;
    hasSettings?: boolean;
    /**
     * Categorizes the tool for global permission management.
     */
    permissionGroup?: ToolPermissionGroup;
    parameters: {
        name: string;
        type: string;
        description: string;
        required: boolean;
    }[];
    execute(params: any, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }>;
}
