import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatMessage, LollmsAPI } from './lollmsAPI';

export interface DiscussionGroup {
    id: string;
    title: string;
    description: string;
    timestamp: number;
}

export interface Discussion {
    id: string;
    groupId: string | null;
    title: string;
    messages: ChatMessage[];
    timestamp: number;
}

export class DiscussionManager {
    private baseDir: string;
    private discussionsDir: string;
    private groupsFilePath: string;

    constructor(private workspaceRootUri: vscode.Uri, private lollmsAPI: LollmsAPI) {
        this.baseDir = path.join(workspaceRootUri.fsPath, '.vscode', '.lollms');
        this.discussionsDir = path.join(this.baseDir, 'discussions');
        this.groupsFilePath = path.join(this.baseDir, 'groups.json');
    }

    private async ensureBaseDir(): Promise<void> {
        try {
            await fs.promises.mkdir(this.discussionsDir, { recursive: true });
        } catch (error) {
            console.error('Failed to create discussions directory:', error);
        }
    }

    // GROUP METHODS
    public async getGroups(): Promise<DiscussionGroup[]> {
        try {
            if (!fs.existsSync(this.groupsFilePath)) {
                return [];
            }
            const content = await fs.promises.readFile(this.groupsFilePath, 'utf-8');
            const groups = JSON.parse(content) as DiscussionGroup[];
            return groups.sort((a, b) => b.timestamp - a.timestamp);
        } catch (error) {
            console.error('Error loading groups:', error);
            return [];
        }
    }

    public async saveGroups(groups: DiscussionGroup[]): Promise<void> {
        await this.ensureBaseDir();
        try {
            await fs.promises.writeFile(this.groupsFilePath, JSON.stringify(groups, null, 2));
        } catch (error) {
            console.error('Error saving groups:', error);
        }
    }

    public async deleteGroup(groupId: string): Promise<void> {
        const groups = await this.getGroups();
        const updatedGroups = groups.filter(g => g.id !== groupId);
        await this.saveGroups(updatedGroups);

        // Set discussions in this group to ungrouped
        const discussions = await this.getDiscussions(groupId);
        for (const discussion of discussions) {
            discussion.groupId = null;
            await this.saveDiscussion(discussion);
        }
    }

    // DISCUSSION METHODS
    public async getDiscussions(groupId?: string | null): Promise<Discussion[]> {
        await this.ensureBaseDir();
        try {
            const files = await fs.promises.readdir(this.discussionsDir);
            const allDiscussions: Discussion[] = await Promise.all(
                files
                    .filter(file => file.endsWith('.json'))
                    .map(async file => {
                        const filePath = path.join(this.discussionsDir, file);
                        const content = await fs.promises.readFile(filePath, 'utf-8');
                        return JSON.parse(content) as Discussion;
                    })
            );

            const filtered = allDiscussions.filter(d => {
                if (groupId === undefined) return true; // all discussions
                return d.groupId === groupId; // discussions in a specific group or ungrouped
            });

            return filtered.sort((a, b) => b.timestamp - a.timestamp);
        } catch (error) {
            console.error('Error listing discussions:', error);
            return [];
        }
    }

    public async getDiscussion(id: string): Promise<Discussion | null> {
        const filePath = path.join(this.discussionsDir, `${id}.json`);
        try {
            if (fs.existsSync(filePath)) {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                return JSON.parse(content) as Discussion;
            }
        } catch (error) {
            console.error(`Error loading discussion ${id}:`, error);
        }
        return null;
    }

    public async saveDiscussion(discussion: Discussion): Promise<void> {
        await this.ensureBaseDir();
        const filePath = path.join(this.discussionsDir, `${discussion.id}.json`);
        try {
            await fs.promises.writeFile(filePath, JSON.stringify(discussion, null, 2));
        } catch (error) {
            console.error(`Error saving discussion ${discussion.id}:`, error);
        }
    }

    public async deleteDiscussion(id: string): Promise<void> {
        const filePath = path.join(this.discussionsDir, `${id}.json`);
        try {
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
            }
        } catch (error) {
            console.error(`Error deleting discussion ${id}:`, error);
        }
    }

    public createNewDiscussion(groupId: string | null = null): Discussion {
        const timestamp = Date.now();
        return {
            id: timestamp.toString(),
            groupId: groupId,
            title: 'New Discussion',
            timestamp: timestamp,
            messages: [{
                role: 'assistant',
                content: `Hello! I'm **Lollms**, your AI coding assistant. What can I help you with today?`
            }]
        };
    }

    public async generateDiscussionTitle(discussion: Discussion): Promise<string | null> {
        if (discussion.messages.length < 2) {
            return null;
        }

        const conversationText = discussion.messages
            .map(m => `**${m.role}**: ${typeof m.content === 'string' ? m.content.substring(0, 200) : '...'}`)
            .join('\n');
        
        const prompt: ChatMessage[] = [
            {
                role: 'system',
                content: 'You are an expert at summarizing conversations. Generate a very short, concise title (5 words or less) for the following conversation. Do not use quotes or any other formatting.'
            },
            {
                role: 'user',
                content: conversationText
            }
        ];

        try {
            const title = await this.lollmsAPI.sendChat(prompt);
            return title.trim().replace(/["']/g, ''); // Remove quotes
        } catch (error) {
            console.error("Failed to generate discussion title:", error);
            vscode.window.showErrorMessage("Failed to generate title from AI.");
            return null;
        }
    }
}