import * as vscode from 'vscode';
import { Workflow, WorkflowNode, NodeExecutionContext } from './types';
import { NODE_REGISTRY } from './nodes';
import { LollmsAPI } from '../lollmsAPI';

export class WorkflowEngine {
    constructor(private lollms: LollmsAPI) {}

    public async executeWorkflow(
        workflow: Workflow, 
        workspaceRoot: string, 
        logger: (msg: string) => void,
        onStatusUpdate: (nodeId: string, status: string) => void
    ) {
        logger(`Starting Workflow: ${workflow.name}`);

        const context: NodeExecutionContext = {
            workspaceRoot,
            variables: new Map(),
            lollms: this.lollms,
            logger
        };

        // Find Start Node or FileIterator (roots)
        const roots = workflow.nodes.filter(n => this.isRoot(n, workflow));

        for (const root of roots) {
            await this.processNode(root, workflow, context, onStatusUpdate);
        }

        logger(`Workflow Completed.`);
    }

    private isRoot(node: WorkflowNode, workflow: Workflow): boolean {
        return !workflow.edges.some(e => e.target === node.id);
    }

    private async processNode(
        node: WorkflowNode, 
        workflow: Workflow, 
        context: NodeExecutionContext, 
        onStatusUpdate: (nodeId: string, status: string) => void,
        inputData: any = {}
    ) {
        node.status = 'running';
        onStatusUpdate(node.id, 'running');
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
                    node.status = 'completed';
                    onStatusUpdate(node.id, 'completed');

                    const edge = workflow.edges.find(e => e.source === node.id && e.sourceHandle === path);
                    if (edge) {
                        const nextNode = workflow.nodes.find(n => n.id === edge.target);
                        if (nextNode) await this.processNode(nextNode, workflow, context, onStatusUpdate, inputData);
                    }
                    return; 
                case 'loop':
                    context.logger(`[Flow] Loop node starting up to ${node.data.maxIterations || 3} iterations...`);
                    let loopResult = inputData;
                    const max = node.data.maxIterations || 3;
                    for (let i = 0; i < max; i++) {
                        context.logger(`[Loop] Iteration ${i+1}/${max}`);
                        // Execute loop body sequentially
                        const loopEdges = workflow.edges.filter(e => e.source === node.id);
                        for (const e of loopEdges) {
                            const nextNode = workflow.nodes.find(n => n.id === e.target);
                            if (nextNode) {
                                await this.processNode(nextNode, workflow, context, onStatusUpdate, loopResult);
                            }
                        }
                    }
                    node.status = 'completed';
                    onStatusUpdate(node.id, 'completed');
                    return;
                default:
                    context.logger(`Warning: Implementation for ${node.type} missing.`);
            }

            node.status = 'completed';
            onStatusUpdate(node.id, 'completed');
            node.lastOutput = result;

            // Trigger downstream
            const outgoing = workflow.edges.filter(e => e.source === node.id);
            for (const edge of outgoing) {
                const nextNode = workflow.nodes.find(n => n.id === edge.target);
                if (nextNode) await this.processNode(nextNode, workflow, context, onStatusUpdate, result);
            }

        } catch (e: any) {
            node.status = 'error';
            onStatusUpdate(node.id, 'error');
            context.logger(`Error in ${node.data.label}: ${e.message}`);
        }
    }

    private async executeAgentNode(node: WorkflowNode, input: any, context: NodeExecutionContext) {
        const messages: ChatMessage[] = [
            { role: 'system', content: node.data.persona || "You are a helpful assistant." },
            { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) }
        ];
        // Standard non-streaming chat call
        return await this.lollms.sendChat(messages, null, undefined, node.data.model);
    }

    private async executeToolNode(node: WorkflowNode, input: any, context: NodeExecutionContext) {
        const toolName = node.data.toolName;
        if (!toolName) throw new Error("Tool node missing target toolName.");

        context.logger(`[Tool] Running tool: ${toolName}...`);

        // Execute tool using our existing command execution fallback or raw shell commands
        if (toolName === 'execute_command' && node.data.params?.command) {
            const { runCommandInTerminal } = require('../extensionState');
            const result = await runCommandInTerminal(node.data.params.command, context.workspaceRoot, "Workflow Tool", undefined, { stealth: true });
            return result.output;
        }

        return `Executed ${toolName} with parameters: ${JSON.stringify(node.data.params || {})}`;
    }

    private async evaluateCondition(node: WorkflowNode, input: any, context: NodeExecutionContext): Promise<string> {
        const prompt = `Based on the following input, should we proceed with "true" or "false"?\nCriteria: ${node.data.criteria}\nInput: ${JSON.stringify(input)}`;
        const res = await this.lollms.sendChat([{ role: 'user', content: prompt }], null, undefined, "small_model");
        return res.toLowerCase().includes('true') ? 'true' : 'false';
    }
}
