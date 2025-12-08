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
}

export interface ToolExecutionEnv {
    workspaceRoot?: vscode.WorkspaceFolder;
    lollmsApi: LollmsAPI;
    contextManager: ContextManager;
    codeGraphManager?: CodeGraphManager;
    skillsManager?: SkillsManager;
    currentPlan: Plan | null;
    agentManager: AgentManager;
}

export interface ToolDefinition {
    name: string;
    description: string;
    longDescription?: string;
    isAgentic: boolean;
    isDefault: boolean;
    hasSettings?: boolean; 
    parameters: {
        name: string;
        type: string;
        description: string;
        required: boolean;
    }[];
    execute(params: any, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }>;
}
