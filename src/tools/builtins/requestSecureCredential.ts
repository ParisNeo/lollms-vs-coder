import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const requestSecureCredentialTool: ToolDefinition = {
    name: "request_secure_credential",
    description: "Requests a secure credential (like a password, API key, or connection URL) from the user. The agent will receive a UUID placeholder (e.g., SEC-xxxx) instead of the actual value. Use this UUID directly in subsequent tool calls (e.g. in execute_command or generate_code). The system will automatically replace the UUID with the real value before execution, keeping it hidden from chat logs and LLM memory.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "prompt_message", type: "string", description: "The message to display to the user explaining what credential is needed (e.g., 'Enter your SFTP password').", required: true }
    ],
    async execute(params: { prompt_message: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.prompt_message) {
            return { success: false, output: "Error: prompt_message is required." };
        }

        // Use native VS Code password input to hide characters
        const secretValue = await vscode.window.showInputBox({
            prompt: params.prompt_message,
            password: true,
            ignoreFocusOut: true,
            placeHolder: "Secret value will be hidden"
        });

        if (!secretValue) {
            return { success: false, output: "User cancelled or provided an empty credential." };
        }

        // Generate a unique placeholder for the agent
        const uuid = 'SEC-' + Math.random().toString(36).substring(2, 7).toUpperCase();

        if (!env.agentManager) {
            return { success: false, output: "Error: Agent Manager not found in environment." };
        }

        // Store the mapping in the current session
        if (!env.agentManager.sessionState.secureCredentials) {
            env.agentManager.sessionState.secureCredentials = {};
        }
        env.agentManager.sessionState.secureCredentials[uuid] = secretValue;

        return { 
            success: true, 
            output: `Credential received and secured. Use this exact placeholder in your next tool parameters: ${uuid}` 
        };
    }
};