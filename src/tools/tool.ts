import * as vscode from 'vscode';
import { LollmsAPI } from '../lollmsAPI';
import { ContextManager } from '../contextManager';
import type { AgentManager } from '../agentManager';
import type { CodeGraphManager } from '../codeGraphManager';
import { SkillsManager } from '../skillsManager';
import { PersonalityManager } from '../personalityManager';

export interface Task {
    id: number;
    task_type: 'simple_action' | 'agentic_action' | 'markdown_coding' | 'safety_check';
    description: string;
    action: string;
    parameters: { [key: string]: any };
    model?: string; 
    agent_persona?: string; 
    agent_skills?: string[]; 
    agent_files?: string[]; 
    dependencies?: number[]; 
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    progress?: number; // 0 to 100
    current_substep?: string; // e.g. "Downloading package 3/10..."
    result: string | null;
    memory_delta?: {
        variables?: Record<string, any>;
        discoveries?: string[];
        thought?: string;
    };
    artifacts?: string[]; // XML tags like <milestone /> or <project_memory />
    retries: number;
    can_retry?: boolean;
}

export interface Milestone {
    label: string;
    status: 'pending' | 'completed' | 'active';
}

export interface Plan {
    objective: string;      
    current_sub_goal: string; 
    observations: string[];  
    tasks: Task[];
    milestones?: Milestone[]; 
    investigation?: any[]; 
    attempts?: Plan[];     
    status?: 'active' | 'stale' | 'failed' | 'active';
    metrics?: any;
    scratchpad: string;    
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
    /**
     * A string showing the LLM exactly how to use this tool in Discussion Mode.
     * Example: <lollms_tool name="execute_command" params='{"command": "ls"}' />
     */
    manualTagFormat?: string;
    execute(params: any, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }>;
    }
