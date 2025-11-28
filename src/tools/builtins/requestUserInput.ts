import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const requestUserInputTool: ToolDefinition = {
    name: "request_user_input",
    description: "Prompts the user for input.",
    isAgentic: false,
    isDefault: true,
    parameters: [
        { name: "question", type: "string", description: "The question to ask the user.", required: true }
    ],
    async execute(params: { question: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.question) {
            return { success: false, output: "Error: 'question' parameter is required." };
        }
        
        try {
            const userInput = await env.agentManager.requestUserInput(params.question, signal);
            return { success: true, output: `User provided input: ${userInput}` };
        } catch (error: any) {
            return { success: false, output: `Input request cancelled or failed: ${error.message}` };
        }
    }
};
