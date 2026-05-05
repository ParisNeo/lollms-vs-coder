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
        node.status = 'running';
        context.logger(`[Flow] Node ${node.data.label} (${node.type}) started...`);

        try {
            let result: any;

            switch (node.type) {
                case 'agent':
                    result = await this.executeAgentNode(node, inputData, context);
                    break;
                case 'tool':
                    result = await this.executeToolNode(node, inputData, context);
                    break;
                case 'condition':
                    const path = await this.evaluateCondition(node, inputData, context);
                    const edge = workflow.edges.find(e => e.source === node.id && e.sourceHandle === path);
                    if (edge) {
                        const nextNode = workflow.nodes.find(n => n.id === edge.target);
                        if (nextNode) await this.processNode(nextNode, workflow, context, inputData);
                    }
                    return; // Condition node handles its own next step
                case 'parallel':
                    const branches = workflow.edges.filter(e => e.source === node.id);
                    await Promise.all(branches.map(async (e) => {
                        const nextNode = workflow.nodes.find(n => n.id === e.target);
                        if (nextNode) await this.processNode(nextNode, workflow, context, inputData);
                    }));
                    return;
                default:
                    context.logger(`Warning: Implementation for ${node.type} missing.`);
            }

            node.status = 'completed';
            node.lastOutput = result;

            // Trigger downstream
            const outgoing = workflow.edges.filter(e => e.source === node.id);
            for (const edge of outgoing) {
                const nextNode = workflow.nodes.find(n => n.id === edge.target);
                if (nextNode) await this.processNode(nextNode, workflow, context, result);
            }

        } catch (e: any) {
            node.status = 'error';
            context.logger(`Error in ${node.data.label}: ${e.message}`);
        }
    }

    private async executeAgentNode(node: WorkflowNode, input: any, context: NodeExecutionContext) {
        const messages: ChatMessage[] = [
            { role: 'system', content: node.data.persona || "You are a helpful assistant." },
            { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) }
        ];
        return await context.lollms.sendChat(messages, null, undefined, node.data.model);
    }

    private async executeToolNode(node: WorkflowNode, input: any, context: NodeExecutionContext) {
        // Logic to trigger tool via LollmsServices...
        return { success: true, output: "Tool logic executed." };
    }

    private async evaluateCondition(node: WorkflowNode, input: any, context: NodeExecutionContext): Promise<string> {
        const prompt = `Based on the following input, should we proceed with "true" or "false"?\nCriteria: ${node.data.criteria}\nInput: ${JSON.stringify(input)}`;
        const res = await context.lollms.sendChat([{ role: 'user', content: prompt }], null, undefined, "small_model");
        return res.toLowerCase().includes('true') ? 'true' : 'false';
    }
}
