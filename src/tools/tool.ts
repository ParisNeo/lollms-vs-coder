import * as vscode from 'vscode';
import { LollmsAPI } from '../lollmsAPI';
import { ContextManager } from '../contextManager';
import type { AgentManager } from '../agentManager';
import type { CodeGraphManager } from '../codeGraphManager';
import { SkillsManager } from '../skillsManager';
import { PersonalityManager } from '../personalityManager';

export interface Task {
    id: number;
    description: string;
    action: string;
    parameters: { [key: string]: any };
    model?: string; // Specific model for this specialist
    agent_persona?: string; // Custom instructions for the specialist
    agent_skills?: string[]; // Specific skills for the specialist
    agent_files?: string[]; // Specific files this agent needs to read
    dependencies?: number[]; // Task IDs that must complete before this starts
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    result: string | null;
    memory_delta?: {
        variables?: Record<string, any>;
        discoveries?: string[];
        thought?: string;
    };
    retries: number;
    can_retry?: boolean;
}

export interface Milestone {
    label: string;
    status: 'pending' | 'completed' | 'active';
}

export interface Plan {
    objective: string;      // Global Mission Goal
    current_sub_goal: string; // Immediate task objective
    observations: string[];  // Incremental list of technical remarks
    tasks: Task[];
    milestones?: Milestone[]; 
    investigation?: any[]; 
    attempts?: Plan[];     
    status?: 'active' | 'stale' | 'failed';
    metrics?: any;
    scratchpad?: string;    // Legacy fallback
}

export interface ToolExecutionEnv {
    workspaceRoot?: vscode.WorkspaceFolder;
    lollmsApi: LollmsAPI;
    contextManager: ContextManager;
    codeGraphManager?: CodeGraphManager;
    skillsManager?: SkillsManager;
    personalityManager?: PersonalityManager;
    currentPlan: Plan | null;
    agentManager?: AgentManager; // Made optional for Companion use
    taskModel?: string; // Specific model requested by the architect for this task
    taskPersona?: string; // Specific instructions requested by the architect
    taskSkills?: string[]; // Specific skills requested by the architect
    taskFiles?: string[]; // Specific files requested by the architect
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
