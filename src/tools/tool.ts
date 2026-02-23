import * as vscode from 'vscode';
import { LollmsAPI } from '../lollmsAPI';
import { ContextManager } from '../contextManager';
import type { AgentManager } from '../agentManager';
import type { CodeGraphManager } from '../codeGraphManager';
import { SkillsManager } from '../skillsManager';

export interface Task {
    id: number;
    description: string;
    action: string;
    parameters: { [key: string]: any };
    model?: string; // Specific model for this specialist
    agent_persona?: string; // Custom instructions for the specialist
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    result: string | null;
    retries: number;
    can_retry?: boolean;
}

export interface Plan {
    objective: string;
    scratchpad: string;
    tasks: Task[];
    investigation?: any[]; 
    attempts?: Plan[];     
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
