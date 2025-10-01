import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { getProcessedSystemPrompt, stripThinkingTags } from './utils';
import { ProcessManager } from './processManager';

export interface Discussion {
    id: string;
    title: string;
    messages: ChatMessage[];
    timestamp: number;
    groupId: string | null;
}

export interface DiscussionGroup {
    id: string;
    title:string;
    description: string;
    timestamp: number;
}

export class DiscussionManager {
    private discussionsDir!: vscode.Uri;
    private groupsFile!: vscode.Uri;
    private lollmsAPI: LollmsAPI;
    private processManager: ProcessManager;

    constructor(lollmsAPI: LollmsAPI, processManager: ProcessManager) {
        this.lollmsAPI = lollmsAPI;
        this.processManager = processManager;
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

    createNewDiscussion(groupId: string | null = null): Discussion {
        const id = Date.now().toString() + Math.random().toString(36).substring(2);
        return {
            id,
            title: 'New Discussion',
            messages: [],
            timestamp: Date.now(),
            groupId
        };
    }

    async saveDiscussion(discussion: Discussion): Promise<void> {
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
        if (discussion.messages.length === 0) {
            return null;
        }
    
        const systemPrompt: ChatMessage = {
            role: 'system',
            content: `You are an expert at summarizing conversations. Your task is to generate a concise, descriptive title (5 words or less) based on the provided conversation.

**CRITICAL INSTRUCTIONS:**
1.  **JSON ONLY:** Your entire response MUST be a single, valid JSON object inside a \`\`\`json markdown block.
2.  **NO EXTRA TEXT:** Do not add any conversational text or explanations outside the JSON block.
3.  **SCHEMA:** The JSON object must have a single key: "title".
4.  **DO NOT ANSWER THE PROMPT:** Your sole purpose is to create the title.

**Example Conversation:**
User: "how do I build a snake game in python?"

**Example Response:**
\`\`\`json
{
  "title": "Python Snake Game Implementation"
}
\`\`\`
`
        };
    
        const userMessages = discussion.messages.filter(m => m.role === 'user').slice(0, 2);
        if (userMessages.length === 0) return null;
    
        const conversationForTitle = userMessages
            .map(m => `**${m.role}:** ${typeof m.content === 'string' ? m.content.substring(0, 500) : JSON.stringify(m.content)}`)
            .join('\n\n');
    
        const userPrompt: ChatMessage = {
            role: 'user',
            content: `Generate a title for this conversation:\n\n${conversationForTitle}`
        };
    
        try {
            const rawResponse = await this.lollmsAPI.sendChat([systemPrompt, userPrompt], null);
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
            
            console.warn("AI did not return valid JSON for title generation. Using first line of response instead. Raw response:", rawResponse);
            const firstLine = cleanResponse.split('\n')[0].trim();
            if (firstLine.length > 80 || firstLine.includes('```')) {
                return "Untitled Discussion"; // A safe default if the response looks like an answer
            }
            return firstLine.replace(/["']/g, '');
    
        } catch (error) {
            console.error("Failed to generate discussion title:", error);
            return null;
        }
    }
}