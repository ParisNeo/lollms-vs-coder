export interface NodeData {
    [key: string]: any;
}

export type WorkflowNodeType = 
    | 'start' 
    | 'agent' 
    | 'tool' 
    | 'condition' 
    | 'parallel' 
    | 'merge' 
    | 'loop' 
    | 'memory_update';

export interface WorkflowNode {
    id: string;
    type: WorkflowNodeType;
    position: { x: number; y: number };
    data: {
        label: string;
        // For Agent Nodes
        persona?: string;
        model?: string;
        // For Tool Nodes
        toolName?: string;
        params?: Record<string, any>;
        // For Condition Nodes
        criteria?: string; 
        // For Loop Nodes
        maxIterations?: number;
    };
    // Runtime State
    status?: 'idle' | 'running' | 'completed' | 'error';
    lastOutput?: any;
}

export interface WorkflowEdge {
    id: string;
    source: string;
    sourceHandle: string;
    target: string;
    targetHandle: string;
}

export interface Workflow {
    id: string;
    name: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
}

export interface NodeExecutionContext {
    workspaceRoot: string;
    variables: Map<string, any>;
    lollms: any; // Reference to LollmsAPI
    logger: (msg: string) => void;
}
