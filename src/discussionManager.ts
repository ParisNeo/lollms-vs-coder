import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { getProcessedSystemPrompt, stripThinkingTags, DiscussionCapabilities, HerdParticipant } from './utils';
import { ProcessManager } from './processManager';
import { Plan } from './tools/tool';

export interface Discussion {
    id: string;
    title: string;
    messages: ChatMessage[];
    timestamp: number;
    groupId: string | null;
    plan?: Plan | null; 
    model?: string;
    capabilities?: DiscussionCapabilities; 
    personalityId?: string;
    gitState?: { originalBranch: string, tempBranch: string };
    importedSkills?: string[];
}

export interface DiscussionGroup {
    id: string;
    title: string;
    description: string;
    timestamp: number;
}

export class DiscussionManager {
    private discussionsDir!: vscode.Uri;
    private groupsFile!: vscode.Uri;
    private lollmsAPI: LollmsAPI;
    private processManager: ProcessManager;
    private context: vscode.ExtensionContext;

    constructor(lollmsAPI: LollmsAPI, processManager: ProcessManager, context: vscode.ExtensionContext) {
        this.lollmsAPI = lollmsAPI;
        this.processManager = processManager;
        this.context = context;
    }

    public async switchWorkspace(workspaceRoot: vscode.Uri) {
        this.discussionsDir = vscode.Uri.joinPath(workspaceRoot, '.lollms', 'discussions');
        this.groupsFile = vscode.Uri.joinPath(workspaceRoot, '.lollms', 'discussion_groups.json');
        await this.initialize();
    }

    private async initialize() {
        try {
            await vscode.workspace.fs.createDirectory(this.discussionsDir);
        } catch (e) {}
    }

    public async saveLastCapabilities(caps: DiscussionCapabilities) {
        await this.context.globalState.update('lollms_last_capabilities', caps);
    }

    public getLastCapabilities(): DiscussionCapabilities {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const allowedFormats = config.get<any>('allowedFileFormats') || { fullFile: true, insert: false, replace: false, delete: false };
        
        const herdPreAnswerParticipants = config.get<HerdParticipant[]>('herdPreAnswerParticipants') || [];
        const herdPostAnswerParticipants = config.get<HerdParticipant[]>('herdPostAnswerParticipants') || [];
        const herdRounds = config.get<number>('herdRounds') || 2;
        const herdDynamicMode = config.get<boolean>('herdDynamicMode') || false;

        const defaults: DiscussionCapabilities = {
            codeGenType: 'full',
            allowedFormats: allowedFormats,
            fileRename: true,
            fileDelete: true,
            fileSelect: true,
            fileReset: true,
            imageGen: true,
            webSearch: false,
            arxivSearch: false,
            funMode: false,
            thinkingMode: 'none',
            herdMode: false,
            herdDynamicMode: herdDynamicMode,
            herdParticipants: [], 
            herdPreAnswerParticipants: herdPreAnswerParticipants,
            herdPostAnswerParticipants: herdPostAnswerParticipants,
            herdRounds: herdRounds,
            agentMode: false,
            autoContextMode: false,
            gitWorkflow: false,
            guiState: {
                agentBadge: true,
                autoContextBadge: true,
                herdBadge: true
            }
        };

        const saved = this.context.globalState.get<DiscussionCapabilities>('lollms_last_capabilities');
        
        if (saved) {
            const merged = { ...defaults, ...saved };
            // Legacy Migration
            if ((!merged.herdPreAnswerParticipants || merged.herdPreAnswerParticipants.length === 0) && (merged as any).herdPreCodeParticipants) {
                merged.herdPreAnswerParticipants = (merged as any).herdPreCodeParticipants;
            }
            if ((!merged.herdPostAnswerParticipants || merged.herdPostAnswerParticipants.length === 0) && (merged as any).herdPostCodeParticipants) {
                merged.herdPostAnswerParticipants = (merged as any).herdPostCodeParticipants;
            }
            return merged;
        }
        return defaults;
    }

    createNewDiscussion(groupId: string | null = null): Discussion {
        const id = Date.now().toString() + Math.random().toString(36).substring(2);
        const caps = this.getLastCapabilities();
        return {
            id,
            title: 'New Discussion',
            messages: [],
            timestamp: Date.now(),
            groupId,
            plan: null,
            capabilities: caps,
            personalityId: 'default_coder'
        };
    }

    async saveDiscussion(discussion: Discussion): Promise<void> {
        if (discussion.id.startsWith('temp-')) return;
        const filePath = vscode.Uri.joinPath(this.discussionsDir, `${discussion.id}.json`);
        const content = Buffer.from(JSON.stringify(discussion, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(filePath, content);
    }
    
    async getDiscussion(id: string): Promise<Discussion | null> {
        const filePath = vscode.Uri.joinPath(this.discussionsDir, `${id}.json`);
        try {
            const content = await vscode.workspace.fs.readFile(filePath);
            return JSON.parse(content.toString());
        } catch (error) { return null; }
    }

    async getAllDiscussions(): Promise<Discussion[]> {
        const discussions: Discussion[] = [];
        try {
            const entries = await vscode.workspace.fs.readDirectory(this.discussionsDir);
            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.json')) {
                    const discussion = await this.getDiscussion(path.parse(name).name);
                    if (discussion) discussions.push(discussion);
                }
            }
        } catch (error) {}
        return discussions.sort((a, b) => b.timestamp - a.timestamp);
    }

    async deleteDiscussion(id: string): Promise<void> {
        this.processManager.cancelForDiscussion(id);
        const filePath = vscode.Uri.joinPath(this.discussionsDir, `${id}.json`);
        try { await vscode.workspace.fs.delete(filePath); } catch (error) {}
    }

    async cleanEmptyDiscussions(): Promise<number> {
        const allDiscussions = await this.getAllDiscussions();
        let deletedCount = 0;
        for (const discussion of allDiscussions) {
            if (!discussion.messages || discussion.messages.length === 0) {
                await this.deleteDiscussion(discussion.id);
                deletedCount++;
            }
        }
        return deletedCount;
    }
    
    async getGroups(): Promise<DiscussionGroup[]> {
        try {
            const content = await vscode.workspace.fs.readFile(this.groupsFile);
            return JSON.parse(content.toString());
        } catch (error) { return []; }
    }

    async saveGroups(groups: DiscussionGroup[]): Promise<void> {
        const content = Buffer.from(JSON.stringify(groups, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(this.groupsFile, content);
    }

    async deleteGroup(groupId: string): Promise<void> {
        const groups = await this.getGroups();
        const updatedGroups = groups.filter(g => g.id !== groupId);
        await this.saveGroups(updatedGroups);
        const allDiscussions = await this.getAllDiscussions();
        for (const discussion of allDiscussions) {
            if (discussion.groupId === groupId) {
                discussion.groupId = null;
                await this.saveDiscussion(discussion);
            }
        }
    }

    async generateDiscussionTitle(discussion: Discussion): Promise<string | null> {
        if (!discussion.messages || discussion.messages.length === 0) return null;
        
        // Find the first user message
        const firstUserMessage = discussion.messages.find(m => m.role === 'user');
        if (!firstUserMessage) return null;

        // Truncate to avoid context overflow for simple title task
        let contentSnippet = typeof firstUserMessage.content === 'string' 
            ? firstUserMessage.content.substring(0, 2000) 
            : firstUserMessage.content.filter(part => part.type === 'text').map(part => part.text).join('\n').substring(0, 2000);
    
        const systemPrompt: ChatMessage = {
            role: 'system',
            content: `You are a title generation AI. Create a descriptive, professional title (5 words or less) for the conversation based on the provided user message.
Your response MUST be a valid JSON object: {"title": "..."}.
Output ONLY the JSON.`
        };

        try {
            const rawResponse = await this.lollmsAPI.sendChat([
                systemPrompt, 
                { role: 'user', content: `Generate a title for a discussion starting with: "${contentSnippet}"` }
            ], null, undefined, discussion.model);

            const cleanResponse = stripThinkingTags(rawResponse).trim();
            
            // Robust JSON extraction
            const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.title) return parsed.title.trim().replace(/["']/g, '');
                } catch (e) {
                    console.warn("Title JSON parse failed, falling back to raw text.", e);
                }
            }

            // Fallback: If no JSON, try to take the first line as the title
            const fallbackTitle = cleanResponse.split('\n')[0].trim().replace(/[#{}"']/g, '').substring(0, 60);
            return fallbackTitle || null;

        } catch (error: any) {
            console.error("Title generation API error:", error);
            throw error; // Rethrow to let the command handler report it
        }
    }
}
