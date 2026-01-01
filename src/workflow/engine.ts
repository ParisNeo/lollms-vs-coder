import * as vscode from 'vscode';
import { Workflow, WorkflowNode, NodeExecutionContext } from './types';
import { NODE_REGISTRY } from './nodes';
import { LollmsAPI } from '../lollmsAPI';

export class WorkflowEngine {
    constructor(private lollms: LollmsAPI) {}

    public async executeWorkflow(workflow: Workflow, workspaceRoot: string, logger: (msg: string) => void) {
        logger(`Starting Workflow: ${workflow.name}`);
        
        const context: NodeExecutionContext = {
            workspaceRoot,
            variables: new Map(),
            lollms: this.lollms,
            logger
        };

        // Topological sort or simple traversal?
        // For this MVP, we look for nodes with no inputs connected (Start nodes) or specifically Trigger nodes.
        // Let's assume a linear flow for now or use a queue.
        
        // Find Start Node or FileIterator (roots)
        const roots = workflow.nodes.filter(n => this.isRoot(n, workflow));
        
        for (const root of roots) {
            await this.processNode(root, workflow, context);
        }

        logger(`Workflow Completed.`);
    }

    private isRoot(node: WorkflowNode, workflow: Workflow): boolean {
        // A node is a root if no edges point TO it
        return !workflow.edges.some(e => e.target === node.id);
    }

    private async processNode(node: WorkflowNode, workflow: Workflow, context: NodeExecutionContext, inputData: any = {}) {
        const executor = NODE_REGISTRY[node.type];
        if (!executor) {
            context.logger(`Unknown node type: ${node.type}`);
            return;
        }

        context.logger(`Executing Node: ${node.type} (${node.id})`);

        // If it's an iterator, it has special handling
        if (node.type === 'file_iterator') {
            const result = await executor.execute(node, inputData, context);
            const files = result.files as string[];
            
            // Find downstream nodes
            const outgoingEdges = workflow.edges.filter(e => e.source === node.id);
            
            // Loop!
            for (const file of files) {
                // Pass 'file' as the output to the next node
                for (const edge of outgoingEdges) {
                    const nextNode = workflow.nodes.find(n => n.id === edge.target);
                    if (nextNode) {
                        // Map the iterator output 'currentFile' to the target input
                        await this.processNode(nextNode, workflow, context, { [edge.targetHandle]: file });
                    }
                }
            }
        } else {
            // Standard execution
            const result = await executor.execute(node, inputData, context);
            
            // Pass results to next nodes
            const outgoingEdges = workflow.edges.filter(e => e.source === node.id);
            for (const edge of outgoingEdges) {
                const nextNode = workflow.nodes.find(n => n.id === edge.target);
                if (nextNode) {
                    // Map output key (sourceHandle) to input key (targetHandle)
                    // Note: In a real engine, we need to wait for ALL inputs of a node. 
                    // This recursion assumes single-stream for simplicity.
                    const specificOutput = result[edge.sourceHandle] || result;
                    const nextInput = { ...inputData, [edge.targetHandle]: specificOutput };
                    await this.processNode(nextNode, workflow, context, nextInput);
                }
            }
        }
    }
}
