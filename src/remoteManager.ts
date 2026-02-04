import * as vscode from 'vscode';
import fetch from 'node-fetch';
import * as http from 'http';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { DiscussionManager } from './discussionManager';
import { AgentManager, IAgentUI, UserPermissions } from './agentManager';
import { ToolDefinition, Plan } from './tools/tool';
import { ContextManager } from './contextManager';
import { GitIntegration } from './gitIntegration';
import { CodeGraphManager } from './codeGraphManager';
import { SkillsManager } from './skillsManager';
import { Logger } from './logger';

/**
 * Headless implementation of IAgentUI for remote interactions.
 */
class RemoteUI implements IAgentUI {
    constructor(
        private manager: RemoteManager,
        private channelId: string,
        private platform: 'discord' | 'slack'
    ) {}

    async addMessageToDiscussion(message: ChatMessage): Promise<void> {
        let text = "";
        if (typeof message.content === 'string') {
            text = message.content;
        } else if (Array.isArray(message.content)) {
            text = message.content.map(c => c.type === 'text' ? c.text : '[Image]').join('\n');
        }

        // Only send system/assistant messages back to user. User messages are already there.
        if (message.role === 'system' || message.role === 'assistant') {
            await this.manager.sendMessage(this.platform, this.channelId, text);
        }
    }

    displayPlan(plan: Plan | null): void {
        if (plan && plan.tasks.length > 0) {
            // Find active task to give a "status update" feel
            const active = plan.tasks.find(t => t.status === 'in_progress');
            // We could update a persistent message here if platforms supported editing well via this simple interface
        }
    }

    updateGeneratingState(): void {
        // No-op for headless
    }

    async requestUserInput(question: string, signal: AbortSignal): Promise<string> {
        await this.manager.sendMessage(this.platform, this.channelId, `❓ **Question:** ${question}\n(Reply here)`);
        // Blocking wait not fully implemented for remote polling in this version without complex state mgmt
        return "User input not supported in headless polling mode yet.";
    }

    updateAgentMode(isActive: boolean): void {
        // No-op
    }
}

export class RemoteManager {
    private pollInterval: NodeJS.Timeout | null = null;
    private config: any;
    private activeAgents = new Map<string, AgentManager>(); // DiscussionID -> Agent
    
    // Tracking for Polling
    private lastDiscordId: string | null = null;
    private lastSlackTs: string | null = null;
    
    // Server for Webhooks (Push)
    private httpServer: http.Server | null = null;

    constructor(
        private context: vscode.ExtensionContext,
        private lollmsAPI: LollmsAPI,
        private discussionManager: DiscussionManager,
        private contextManager: ContextManager,
        private gitIntegration: GitIntegration,
        private codeGraphManager: CodeGraphManager,
        private skillsManager: SkillsManager
    ) {
        this.loadConfig();
        
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('lollmsVsCoder.remote')) {
                this.loadConfig();
                this.restart();
            }
        });
    }

    private loadConfig() {
        this.config = vscode.workspace.getConfiguration('lollmsVsCoder.remote');
    }

    public start() {
        // Start Polling if any service is enabled and configured
        const discordEnabled = this.config.discord.enabled && this.config.discord.token;
        const slackEnabled = this.config.slack.enabled && this.config.slack.token;
        
        if (discordEnabled || slackEnabled) {
            const interval = (this.config.pollInterval || 30) * 1000;
            Logger.info(`Starting Remote Manager Polling. Interval: ${interval}ms`);
            
            if (this.pollInterval) clearInterval(this.pollInterval);
            this.pollInterval = setInterval(() => this.poll(), interval);
        }

        // Start Webhook Server if enabled
        const port = this.config.server?.port || 3000;
        // Check if we want to run a server (e.g. for Slack Events API)
        // Currently we only implemented polling logic for simplicity & reliability without public IP
        // but let's provide a basic server structure if user configured it
    }

    public stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = null;
        }
    }

    public restart() {
        this.stop();
        this.start();
    }

    private async poll() {
        try {
            if (this.config.discord.enabled) await this.pollDiscord();
            if (this.config.slack.enabled) await this.pollSlack();
        } catch (e) {
            Logger.error("Remote polling error:", e);
        }
    }

    // --- ACCESS CONTROL LAYER ---

    private checkAccess(userId: string, channelId: string): { allowed: boolean, permissions: UserPermissions } {
        const allowedUsers = this.config.allowedUsers || [];
        const adminUsers = this.config.adminUsers || [];
        const allowedChannels = this.config.allowedChannels || [];

        // 1. Channel Check (if whitelist exists)
        if (allowedChannels.length > 0 && !allowedChannels.includes(channelId)) {
            return { allowed: false, permissions: { canRead: false, canExecute: false } };
        }

        // 2. User Check
        // If whitelist is empty, we default to BLOCK ALL for safety unless it's a DM (maybe?)
        // Safer default: If whitelist empty, nobody access.
        if (allowedUsers.length === 0 && adminUsers.length === 0) {
            return { allowed: false, permissions: { canRead: false, canExecute: false } };
        }

        if (!allowedUsers.includes(userId) && !adminUsers.includes(userId)) {
            return { allowed: false, permissions: { canRead: false, canExecute: false } };
        }

        // 3. Permissions
        const isAdmin = adminUsers.includes(userId);
        return {
            allowed: true,
            permissions: {
                canRead: true,
                canExecute: isAdmin // Only admins can execute tools (files/shell)
            }
        };
    }

    // --- DISCORD POLLING ---

    private async pollDiscord() {
        const token = this.config.discord.token;
        // Currently polling a single channel ID from generic config or list?
        // Requirements say "give it access to one or many channels".
        // Discord API /users/@me/channels is for DMs. /guilds/{id}/channels for servers.
        // Reading all channels is heavy. We'll stick to a configurable list of channels to poll.
        // For now, let's use the 'allowedChannels' list as the poll targets.
        
        const channels = this.config.allowedChannels || [];
        if (channels.length === 0) return;

        for (const channelId of channels) {
            await this.pollDiscordChannel(channelId, token);
        }
    }

    private async pollDiscordChannel(channelId: string, token: string) {
        const url = `https://discord.com/api/v9/channels/${channelId}/messages?limit=5`;
        const headers = { 'Authorization': `Bot ${token}` };

        try {
            const res = await fetch(url, { headers });
            if (!res.ok) return;

            const messages: any[] = await res.json();
            if (!Array.isArray(messages) || messages.length === 0) return;

            // Simple dedup logic: Only process messages newer than last check for this channel
            // For MVP, we need a map of lastId per channel
            // Here we just use a simplified single lastId for demo or robust map
            
            // To properly handle multiple channels, we would need a Map<channelId, lastMessageId>
            // For now, let's assume we process the newest if it hasn't been seen
            
            // NOTE: A robust bot uses Gateway (WebSocket). Polling is a fallback.
            
            const newest = messages[0];
            if (!newest) return;
            
            // Check if we processed this
            const key = `discord-${channelId}`;
            // We store last ID in a transient map
            if (this.lastMessageMap.get(key) === newest.id) return;
            
            this.lastMessageMap.set(key, newest.id);

            // Process message
            if (newest.author.bot) return;
            
            await this.handleRemoteMessage(
                'discord', 
                channelId, 
                newest.content, 
                newest.author.username, 
                newest.author.id
            );

        } catch (e) {
            console.error(`Discord poll failed for ${channelId}`, e);
        }
    }
    
    private lastMessageMap = new Map<string, string>();

    // --- SLACK POLLING ---

    private async pollSlack() {
        const token = this.config.slack.token;
        const channels = this.config.allowedChannels || [];
        if (channels.length === 0) return;

        for (const channelId of channels) {
            await this.pollSlackChannel(channelId, token);
        }
    }

    private async pollSlackChannel(channelId: string, token: string) {
        const url = `https://slack.com/api/conversations.history?channel=${channelId}&limit=5`;
        const headers = { 'Authorization': `Bearer ${token}` };

        try {
            const res = await fetch(url, { headers });
            if (!res.ok) return;
            const data: any = await res.json();
            if (!data.ok || !data.messages) return;

            const newest = data.messages[0];
            if (!newest) return;

            const key = `slack-${channelId}`;
            if (this.lastMessageMap.get(key) === newest.ts) return;
            this.lastMessageMap.set(key, newest.ts);

            if (newest.bot_id) return;

            await this.handleRemoteMessage(
                'slack',
                channelId,
                newest.text,
                newest.user, // User ID in Slack
                newest.user
            );

        } catch (e) {
            console.error(`Slack poll failed for ${channelId}`, e);
        }
    }

    // --- CORE HANDLER ---

    private async handleRemoteMessage(
        platform: 'discord'|'slack', 
        channelId: string, 
        text: string, 
        senderName: string,
        senderId: string
    ) {
        Logger.info(`Remote Message from ${senderName} (${senderId}) in ${channelId}: ${text}`);

        // ACL Check
        const access = this.checkAccess(senderId, channelId);
        if (!access.allowed) {
            Logger.warn(`Access denied for user ${senderId}`);
            // Optionally reply "Access Denied" if configured to be chatty
            return;
        }

        const discussionId = `remote-${platform}-${channelId}`;
        
        let agent = this.activeAgents.get(discussionId);
        if (!agent) {
            // Create UI Adapter
            const ui = new RemoteUI(this, channelId, platform);
            
            // Create Discussion (In-Memory or Saved)
            let discussion = await this.discussionManager.getDiscussion(discussionId);
            if (!discussion) {
                discussion = {
                    id: discussionId,
                    title: `Remote ${platform} Chat`,
                    messages: [],
                    timestamp: Date.now(),
                    groupId: null,
                    plan: null,
                    capabilities: this.discussionManager.getLastCapabilities(),
                    personalityId: 'default_coder'
                };
                await this.discussionManager.saveDiscussion(discussion);
            }

            agent = new AgentManager(
                ui,
                this.lollmsAPI,
                this.contextManager,
                this.gitIntegration,
                this.discussionManager,
                this.context.extensionUri,
                this.codeGraphManager,
                this.skillsManager
            );
            
            // Inject Mock ProcessManager
            const mockProcessManager = {
                register: () => ({ id: 'remote', controller: new AbortController() }),
                unregister: () => {},
                cancel: async () => {},
                cancelForDiscussion: async () => {},
                getForDiscussion: () => undefined,
                getAll: () => [],
                onDidProcessChange: new vscode.EventEmitter<void>().event
            };
            agent.setProcessManager(mockProcessManager as any);

            this.activeAgents.set(discussionId, agent);
        }

        const discussion = await this.discussionManager.getDiscussion(discussionId);
        if (discussion) {
            discussion.messages.push({ role: 'user', content: `${senderName}: ${text}` });
            
            // Get active workspace for tools
            const workspace = vscode.workspace.workspaceFolders?.[0];
            if (workspace) {
                // Pass Permissions to Agent
                await agent.handleUserMessage(text, discussion, workspace, access.permissions);
            } else {
                await this.sendMessage(platform, channelId, "⚠️ **Error:** No active workspace in VS Code. Cannot execute agent tasks.");
            }
        }
    }

    public async sendMessage(platform: 'discord'|'slack', channelId: string, text: string) {
        if (!text) return;

        try {
            if (platform === 'discord') {
                const url = `https://discord.com/api/v9/channels/${channelId}/messages`;
                await fetch(url, {
                    method: 'POST',
                    headers: { 
                        'Authorization': `Bot ${this.config.discord.token}`,
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({ content: text.substring(0, 2000) }) 
                });
            } else if (platform === 'slack') {
                const url = `https://slack.com/api/chat.postMessage`;
                await fetch(url, {
                    method: 'POST',
                    headers: { 
                        'Authorization': `Bearer ${this.config.slack.token}`,
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({ channel: channelId, text: text })
                });
            }
        } catch (e) {
            Logger.error("Failed to send remote message", e);
        }
    }
}
