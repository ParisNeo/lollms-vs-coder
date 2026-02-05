import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const moltbookActionTool: ToolDefinition = {
    name: "moltbook_action",
    description: "Interacts with the Moltbook social network for AI agents. Supports reading feeds, searching, posting, commenting, and voting. Handles authentication automatically.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'internet_access',
    parameters: [
        { 
            name: "action", 
            type: "string", 
            description: "The action to perform. Options: 'register', 'get_feed', 'search', 'post', 'comment', 'get_profile', 'upvote', 'follow', 'subscribe'.", 
            required: true 
        },
        { 
            name: "params", 
            type: "object", 
            description: "Parameters specific to the action. \n- post: {submolt, title, content|url}\n- comment: {post_id, content}\n- search: {q, type?}\n- register: {name, description}", 
            required: false 
        }
    ],
    async execute(params: { action: string, params?: any }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        
        // 1. Get Key (Check Config -> Then Env)
        let apiKey = config.get<string>('moltbook.apiKey')?.trim();
        if (!apiKey) {
            apiKey = process.env.MOLTBOOK_API_KEY?.trim() || "";
        }
        
        // 2. Base URL (Strictly enforced for security)
        const baseUrl = "https://www.moltbook.com/api/v1"; 

        // 3. Registration Handler (Special Case: No Key Required yet)
        if (params.action === 'register') {
            if (apiKey) {
                return { 
                    success: false, 
                    output: "🛑 **Config Error:** An API Key is already configured in Settings. Do not re-register unless you clear the existing key." 
                };
            }
            
            // Ask for permission via Agent UI to ensure user wants to register a new bot
            const answer = await env.agentManager?.requestUserInput(
                "🛡️ **Moltbook Registration:** The agent wants to register a new identity on Moltbook. This will require you to verify it via X (Twitter). Proceed? (yes/no)", 
                signal
            );
            
            if (!answer || !answer.toLowerCase().startsWith('y')) {
                return { success: false, output: "Registration cancelled by user." };
            }

            try {
                const regRes = await fetch(`${baseUrl}/agents/register`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name: params.params?.name || "LollmsAgent",
                        description: params.params?.description || "An AI Coder"
                    }),
                    signal: signal as any
                });
                
                const regData: any = await regRes.json();
                
                if (regData.agent && regData.agent.api_key) {
                    // AUTO-SAVE KEY
                    await config.update('moltbook.apiKey', regData.agent.api_key, vscode.ConfigurationTarget.Global);
                    
                    return { 
                        success: true, 
                        output: `✅ **Registration Successful!**\n\n1. **API Key:** Saved automatically to VS Code Settings.\n2. **Action Required:** You MUST click this link to claim your bot on X: ${regData.agent.claim_url}\n\nOnce claimed, you can start posting.` 
                    };
                }
                return { success: false, output: `Registration failed: ${JSON.stringify(regData)}` };

            } catch (e: any) {
                return { success: false, output: `Network error during registration: ${e.message}` };
            }
        }

        // 4. Auth Check for all other actions
        if (!apiKey) {
            return { success: false, output: "❌ **Authentication Error:** No Moltbook API Key found. Please set `lollmsVsCoder.moltbook.apiKey` in settings or ask the user to register." };
        }

        let url = "";
        let method = "GET";
        let body = null;

        // 5. Route Actions
        try {
            switch (params.action) {
                case 'get_feed': 
                    url = `${baseUrl}/feed?sort=${params.params?.sort || 'hot'}&limit=${params.params?.limit || 15}`; 
                    break;
                case 'search': 
                    url = `${baseUrl}/search?q=${encodeURIComponent(params.params?.q || '')}`; 
                    if (params.params?.type) url += `&type=${params.params.type}`;
                    break;
                case 'get_profile':
                    url = params.params?.name ? `${baseUrl}/agents/profile?name=${params.params.name}` : `${baseUrl}/agents/me`;
                    break;
                case 'post':
                    url = `${baseUrl}/posts`;
                    method = "POST";
                    body = params.params; // {submolt, title, content}
                    break;
                case 'comment':
                    if (!params.params?.post_id) throw new Error("post_id required for comments");
                    url = `${baseUrl}/posts/${params.params.post_id}/comments`;
                    method = "POST";
                    body = { content: params.params.content, parent_id: params.params.parent_id };
                    break;
                case 'upvote':
                    if (!params.params?.id) throw new Error("id required");
                    const type = params.params?.type === 'comment' ? 'comments' : 'posts';
                    url = `${baseUrl}/${type}/${params.params.id}/upvote`;
                    method = "POST";
                    break;
                case 'follow':
                    if (!params.params?.name) throw new Error("Agent name required");
                    url = `${baseUrl}/agents/${params.params.name}/follow`;
                    method = "POST";
                    break;
                case 'subscribe':
                    if (!params.params?.submolt) throw new Error("Submolt name required");
                    url = `${baseUrl}/submolts/${params.params.submolt}/subscribe`;
                    method = "POST";
                    break;
                default:
                    return { success: false, output: `Unknown action: ${params.action}` };
            }

            const headers: any = { 
                "Content-Type": "application/json",
                "User-Agent": "Lollms-VS-Coder",
                "Authorization": `Bearer ${apiKey}`
            };

            const res = await fetch(url, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: signal as any
            });

            // 6. Handle Specific Moltbook Status Codes
            if (res.status === 401) {
                return { success: false, output: "⛔ **401 Unauthorized:** Your API Key is invalid. Please check your settings." };
            }

            if (res.status === 429) {
                const json: any = await res.json();
                const retry = json.retry_after_seconds || (json.retry_after_minutes * 60) || "a while";
                return { 
                    success: false, 
                    output: `⏳ **Rate Limited:** You are posting/commenting too fast. Please wait ${retry} seconds before trying again.\nHint: ${json.hint || ''}` 
                };
            }

            const text = await res.text();
            if (!res.ok) return { success: false, output: `API Error ${res.status}: ${text}` };

            // Truncate very long feed responses to save context
            if (text.length > 8000) {
                return { success: true, output: text.substring(0, 8000) + "\n...[truncated]" };
            }

            return { success: true, output: text };

        } catch (e: any) {
            return { success: false, output: `Tool Execution Error: ${e.message}` };
        }
    }
};
