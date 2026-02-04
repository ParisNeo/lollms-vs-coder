import * as vscode from 'vscode';
import fetch from 'node-fetch';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const moltbookActionTool: ToolDefinition = {
    name: "moltbook_action",
    description: "Interacts with the Moltbook social network. Actions: 'register', 'get_feed', 'search', 'post', 'comment', 'delete_post'.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'internet_access',
    parameters: [
        { name: "action", type: "string", description: "Action to perform.", required: true },
        { name: "params", type: "object", description: "Parameters for the action.", required: false }
    ],
    async execute(params: { action: string, params?: any }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        
        // 1. Get Key
        let apiKey = config.get<string>('moltbook.apiKey')?.trim() || process.env.MOLTBOOK_API_KEY?.trim() || "";
        
        // 2. Registration Guard
        if (params.action === 'register') {
            if (apiKey) {
                return { 
                    success: false, 
                    output: "🛑 **STOP:** An API Key is already configured. Authentication failed with the EXISTING key. \n\n**INSTRUCTION:** Do NOT register a new bot. Ask the user to verify their key in VS Code Settings." 
                };
            }
            
            // Ask for permission
            const answer = await env.agentManager?.requestUserInput(
                "🛡️ **Permission Required:** The agent wants to register a new Moltbook identity. This requires you to claim it on X (Twitter). Proceed? (yes/no)", 
                signal
            );
            
            if (!answer || !answer.toLowerCase().startsWith('y')) {
                return { success: false, output: "Registration cancelled by user." };
            }
        } else {
            if (!apiKey) {
                return { success: false, output: "❌ **No API Key:** Please set 'lollmsVsCoder.moltbook.apiKey' in settings." };
            }
        }

        // 3. Request
        // IMPORTANT: Docs say must use www.moltbook.com to avoid redirect stripping headers
        const baseUrl = "https://www.moltbook.com/api/v1"; 
        let url = "";
        let method = "GET";
        let body = null;

        try {
            switch (params.action) {
                case 'register':
                    url = `${baseUrl}/agents/register`;
                    method = "POST";
                    body = {
                        name: config.get('moltbook.botName', 'LollmsBot'),
                        description: config.get('moltbook.botPurpose', 'AI Assistant')
                    };
                    break;
                case 'get_feed': url = `${baseUrl}/feed`; break;
                case 'search': 
                    url = `${baseUrl}/search?q=${encodeURIComponent(params.params?.q || '')}`; 
                    break;
                case 'post':
                    url = `${baseUrl}/posts`;
                    method = "POST";
                    body = params.params;
                    break;
                case 'comment':
                    url = `${baseUrl}/posts/${params.params?.post_id}/comments`;
                    method = "POST";
                    body = { content: params.params?.content };
                    break;
                default:
                    return { success: false, output: `Unknown action: ${params.action}` };
            }

            const headers: any = { 
                "Content-Type": "application/json",
                "User-Agent": "Lollms-VS-Coder"
            };
            if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

            const res = await fetch(url, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: signal as any
            });

            if (res.status === 401 || res.status === 403) {
                return { 
                    success: false, 
                    output: "⛔ **Authentication Failed:** The provided API Key was rejected by Moltbook. \n\n**INSTRUCTION:** Do NOT try to register. Tell the user to check their key configuration." 
                };
            }

            const text = await res.text();
            if (!res.ok) return { success: false, output: `API Error ${res.status}: ${text}` };

            // Auto-save key on register
            if (params.action === 'register') {
                const json = JSON.parse(text);
                if (json.agent && json.agent.api_key) {
                    await config.update('moltbook.apiKey', json.agent.api_key, vscode.ConfigurationTarget.Global);
                    return { success: true, output: `Registration Successful! Key saved to settings. \n\n👉 **Claim URL:** ${json.agent.claim_url}` };
                }
            }

            return { success: true, output: text };

        } catch (e: any) {
            return { success: false, output: `Network Error: ${e.message}` };
        }
    }
};
