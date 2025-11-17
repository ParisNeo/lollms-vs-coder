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
        const userInput = await vscode.window.showInputBox({ prompt: params.question, title: "Agent is requesting input" });
        if (userInput === undefined) {
            return { success: false, output: "User cancelled the input request." };
        }
        return { success: true, output: `User provided input: ${userInput}` };
    }
};
