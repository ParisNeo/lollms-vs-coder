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
    gitState?: { originalBranch: string, tempBranch: string }; // For Git Workflow
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
        } catch (e) {
            // Directory likely already exists
        }
    }

    public async saveLastCapabilities(caps: DiscussionCapabilities) {
        await this.context.globalState.update('lollms_last_capabilities', caps);
    }

    public getLastCapabilities(): DiscussionCapabilities {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const allowedFormats = config.get<any>('allowedFileFormats') || { fullFile: true, insert: false, replace: false, delete: false };
        
        // Read Herd Mode configuration
        const herdParticipants = config.get<HerdParticipant[]>('herdParticipants') || [];
        const herdPreCodeParticipants = config.get<HerdParticipant[]>('herdPreCodeParticipants') || [];
        const herdPostCodeParticipants = config.get<HerdParticipant[]>('herdPostCodeParticipants') || [];
        const herdRounds = config.get<number>('herdRounds') || 2;
        const herdDynamicMode = config.get<boolean>('herdDynamicMode') || false;

        // Default Capabilities
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
            gitCommit: true,
            // Herd Mode
            herdMode: false,
            herdDynamicMode: herdDynamicMode,
            herdParticipants: herdParticipants, // Legacy
            herdPreCodeParticipants: herdPreCodeParticipants,
            herdPostCodeParticipants: herdPostCodeParticipants,
            herdRounds: herdRounds,
            // Persistent Modes
            agentMode: false,
            autoContextMode: false,
            // Git Workflow
            gitWorkflow: false,
            // GUI State Defaults (Show Badges)
            guiState: {
                agentBadge: true,
                autoContextBadge: true,
                herdBadge: true
            }
        };

        const saved = this.context.globalState.get<DiscussionCapabilities>('lollms_last_capabilities');
        
        if (saved) {
            // Merge saved with defaults to ensure new fields/structure are present
            const merged = { ...defaults, ...saved };
            
            // Ensure array fields are populated if missing in saved state
            if (!merged.herdPreCodeParticipants || merged.herdPreCodeParticipants.length === 0) {
                merged.herdPreCodeParticipants = defaults.herdPreCodeParticipants;
            }
            if (!merged.herdPostCodeParticipants || merged.herdPostCodeParticipants.length === 0) {
                merged.herdPostCodeParticipants = defaults.herdPostCodeParticipants;
            }
            if (!merged.herdRounds) merged.herdRounds = defaults.herdRounds;
            
            // Ensure guiState exists
            if (!merged.guiState) merged.guiState = defaults.guiState;

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
            personalityId: 'default_coder',
            gitState: undefined
        };
    }

    async saveDiscussion(discussion: Discussion): Promise<void> {
        if (discussion.id.startsWith('temp-')) {
            return;
        }
        const filePath = vscode.Uri.joinPath(this.discussionsDir, `${discussion.id}.json`);
        const content = Buffer.from(JSON.stringify(discussion, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(filePath, content);
    }
    
    async getDiscussion(id: string): Promise<Discussion | null> {
        const filePath = vscode.Uri.joinPath(this.discussionsDir, `${id}.json`);
        try {
            const content = await vscode.workspace.fs.readFile(filePath);
            return JSON.parse(content.toString());
        } catch (error) {
            return null;
        }
    }

    async getAllDiscussions(): Promise<Discussion[]> {
        const discussions: Discussion[] = [];
        try {
            const entries = await vscode.workspace.fs.readDirectory(this.discussionsDir);
            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.json')) {
                    const discussion = await this.getDiscussion(path.parse(name).name);
                    if (discussion) {
                        discussions.push(discussion);
                    }
                }
            }
        } catch (error) {
            // Folder might not exist yet
        }
        return discussions.sort((a, b) => b.timestamp - a.timestamp);
    }

    async deleteDiscussion(id: string): Promise<void> {
        this.processManager.cancelForDiscussion(id);
        const filePath = vscode.Uri.joinPath(this.discussionsDir, `${id}.json`);
        try {
            await vscode.workspace.fs.delete(filePath);
        } catch (error) {
            console.error(`Failed to delete discussion ${id}:`, error);
        }
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
        } catch (error) {
            return [];
        }
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
        if (discussion.messages.length === 0) return null;
        
        const systemPrompt: ChatMessage = {
            role: 'system',
            content: `You are a title generation AI. Your sole purpose is to create a concise, descriptive title (5 words or less) for a conversation based on the user's initial input.

<CRITICAL_OUTPUT_FORMAT>
Your entire response MUST be a single, valid JSON object inside a \`\`\`json markdown block.
The JSON object must have a single key: "title".
DO NOT add any text, conversation, or explanations outside the JSON block.
DO NOT answer the user's prompt.
</CRITICAL_OUTPUT_FORMAT>

**Example Conversation:**
User: "how do I build a snake game in python?"

**Correct Response:**
\`\`\`json
{
  "title": "Python Snake Game Implementation"
}
\`\`\`
`
        };
        const firstUserMessage = discussion.messages.find(m => m.role === 'user');
        if (!firstUserMessage) return null;

        let contentSnippet = '';
        if (typeof firstUserMessage.content === 'string') {
            contentSnippet = firstUserMessage.content.substring(0, 4000); 
        } else if (Array.isArray(firstUserMessage.content)) {
             contentSnippet = firstUserMessage.content
                .filter(part => part.type === 'text')
                .map(part => part.text)
                .join('\n')
                .substring(0, 4000);
        }
    
        const userPrompt: ChatMessage = {
            role: 'user',
            content: `Generate a title for a conversation that starts with:\n\n"${contentSnippet}..."`
        };
    
        try {
            const rawResponse = await this.lollmsAPI.sendChat([systemPrompt, userPrompt], null, undefined, discussion.model);
            const cleanResponse = stripThinkingTags(rawResponse);
    
            const jsonMatch = cleanResponse.match(/```json\s*([\s\S]+?)\s*```/);
            let jsonString = null;
            if (jsonMatch && jsonMatch[1]) {
                jsonString = jsonMatch[1];
            } else {
                const firstBrace = cleanResponse.indexOf('{');
                const lastBrace = cleanResponse.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace > firstBrace) {
                    jsonString = cleanResponse.substring(firstBrace, lastBrace + 1);
                }
            }
    
            if (jsonString) {
                try {
                    const parsed = JSON.parse(jsonString);
                    if (parsed && typeof parsed.title === 'string' && parsed.title.trim() !== '') {
                        return parsed.title.trim().replace(/["']/g, '');
                    }
                } catch (e) {
                    console.warn("Could not parse JSON from title generation response, falling back to plain text.", e);
                }
            }
            
            const firstLine = cleanResponse.split('\n')[0].trim();
            if (firstLine.length > 80 || firstLine.includes('```')) {
                return "Untitled Discussion"; 
            }
            return firstLine.replace(/["']/g, '');
    
        } catch (error) {
            console.error("Failed to generate discussion title:", error);
            return null;
        }
    }
}
