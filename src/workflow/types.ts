export interface NodeData {
    [key: string]: any;
}

export interface WorkflowNode {
    id: string;
    type: string; // 'start', 'end', 'llm', 'file_iterator', 'move_file', 'code_exec'
    position: { x: number; y: number };
    data: NodeData;
    inputs: { [key: string]: string }; // Map input name to source node ID
    outputs: { [key: string]: any };   // Runtime outputs
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
