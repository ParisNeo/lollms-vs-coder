import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { getProcessedGlobalSystemPrompt } from './utils';

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
    private discussionsDir: vscode.Uri;
    private groupsFile: vscode.Uri;
    private lollmsAPI: LollmsAPI;

    constructor(workspaceRoot: vscode.Uri, lollmsAPI: LollmsAPI) {
        this.discussionsDir = vscode.Uri.joinPath(workspaceRoot, '.lollms', 'discussions');
        this.groupsFile = vscode.Uri.joinPath(workspaceRoot, '.lollms', 'discussion_groups.json');
        this.lollmsAPI = lollmsAPI;
        this.initialize();
    }

    private async initialize() {
        try {
            await vscode.workspace.fs.createDirectory(this.discussionsDir);
        } catch (e) {
            // Directory likely already exists
        }
    }

    createNewDiscussion(groupId: string | null = null): Discussion {
        const id = Date.now().toString();
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
    
        const globalPrompt = getProcessedGlobalSystemPrompt();
        const prompt: ChatMessage[] = [
            { 
                role: 'system', 
                content: `You are an expert at summarizing conversations. Based on the following messages, generate a concise and descriptive title (5 words or less). Do not add any prefixes like 'Title:' or use quotation marks. Just return the plain text of the title.\n\nUser preferences: ${globalPrompt}` 
            },
            ...discussion.messages.slice(0, 4) // Use first few messages for context
        ];
    
        try {
            const title = await this.lollmsAPI.sendChat(prompt);
            return title.trim().replace(/["']/g, ''); // Clean up quotes
        } catch (error) {
            console.error("Failed to generate discussion title:", error);
            return null;
        }
    }
}