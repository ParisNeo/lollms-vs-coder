import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { getProcessedSystemPrompt, stripThinkingTags, DiscussionCapabilities, HerdParticipant } from './utils';
import { ProcessManager } from './processManager';
import { Plan } from './tools/tool';
import { Logger } from './logger';

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
    selectedFolders?: string[]; // URIs of selected workspace folders
    activeDiagrams?: string[]; // e.g., ['class_diagram', 'call_graph']
    appliedState?: Record<string, Record<number, number[]>>;
    discussion_data_zone?: string;
    agentSession?: {
        replVariables: Record<string, any>;
        workingMemory: string[];
        completedActionsHistory: string[];
        secureCredentials?: Record<string, string>;
    };
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

    private _onDidChangeDiscussions = new vscode.EventEmitter<void>();
    public readonly onDidChangeDiscussions = this._onDidChangeDiscussions.event;

    constructor(lollmsAPI: LollmsAPI, processManager: ProcessManager, context: vscode.ExtensionContext) {
        this.lollmsAPI = lollmsAPI;
        this.processManager = processManager;
        this.context = context;
    }

    public async switchWorkspace(workspaceRoot: vscode.Uri) {
        // We no longer rely on a single discussionsDir.
        // We initialize for all workspace folders.
        await this.initialize();
        this._onDidChangeDiscussions.fire();
    }

    public async initialize() {
        const folders = vscode.workspace.workspaceFolders ||[];
        for (const folder of folders) {
            const dir = vscode.Uri.joinPath(folder.uri, '.lollms', 'discussions');
            try {
                await vscode.workspace.fs.createDirectory(dir);
            } catch (e) {}
        }
    }

    public async saveLastCapabilities(caps: DiscussionCapabilities) {
        await this.context.globalState.update('lollms_last_capabilities', caps);
    }

    public getLastCapabilities(): DiscussionCapabilities {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const allowedFormats = config.get<any>('allowedFileFormats') || { fullFile: true, insert: false, replace: false, delete: false };
        
        // Load default profile ID from config
        const defaultProfileId = config.get<string>('defaultResponseProfileId') || 'balanced';

        const defaults: DiscussionCapabilities = {
            responseProfileId: defaultProfileId,
            forceFullCode: false,
            generationFormats: {
                fullFile: true,
                partialFormat: 'aider'
            },
            allowedFormats: {
                fullFile: true,
                insert: true,
                replace: true,
                delete: true
            },
            fileRename: true,
            fileDelete: true,
            fileSelect: true,
            fileReset: true,
            imageGen: true,
            enableImages: true,
            useImageModeForDocs: false,
            webSearch: false,
            distillWebResults: config.get<boolean>('distillWebResults') ?? true,
            antiPromptInjection: config.get<boolean>('antiPromptInjection') ?? true,
            searchInCacheFirst: config.get<boolean>('searchInCacheFirst') ?? true,
            clipboardInsertRole: config.get<string>('clipboardInsertRole') as 'user' | 'assistant' || 'user',
            searchSources: {
                google: true,
                arxiv: true,
                wikipedia: true,
                stackoverflow: true,
                youtube: true,
                github: false
            },
            herdMode: false,
            herdParallelGeneration: false,
            herdPreAnswerCount: 3,
            herdPostAnswerCount: 2,
            herdOrchestratorModel: undefined,
            herdParticipantModels: [],
            herdCriticEnabled: false,
            agentMode: false,
            debugMode: false,
            verifierMode: false,
            testMode: config.get<boolean>('testMode') ?? false,
            documentationMode: config.get<boolean>('documentationMode') ?? false,
            maxDebugSteps: 10,
            autoContextMode: false, 
            autoSkillMode: false,
            temperature: 0.7,
            ttftTimeout: 0,
            interTokenTimeout: 0,
            contextAggression: 'respect',
            disableProjectContext: false,
            projectMemoryEnabled: true,
            gitWorkflow: false,
            gitAutoWorkflow: false,
            autoApply: false,
            autoFix: true,
            autoBranch: false,
            maxFixRetries: 3,
            explainCode: true,
            addPedagogicalInstruction: false,
            forceFullCodePath: false,
            guiState: {
                agentBadge: true,
                debugBadge: true,
                autoContextBadge: true,
                herdBadge: true,
                testBadge: true,
                docsBadge: true
            }
        };

        const saved = this.context.globalState.get<DiscussionCapabilities>('lollms_last_capabilities');
        
        if (saved) {
            const merged = { ...defaults, ...saved };
            if ((!merged.herdPreAnswerParticipants || merged.herdPreAnswerParticipants.length === 0) && (merged as any).herdPreCodeParticipants) {
                merged.herdPreAnswerParticipants = (merged as any).herdPreCodeParticipants;
            }
            if ((!merged.herdPostAnswerParticipants || merged.herdPostAnswerParticipants.length === 0) && (merged as any).herdPostCodeParticipants) {
                merged.herdPostAnswerParticipants = (merged as any).herdPostCodeParticipants;
            }
            // Ensure responseProfileId exists if loading old capability object
            if (!merged.responseProfileId) {
                merged.responseProfileId = defaultProfileId;
            }
            return merged;
        }
        return defaults;
    }

    createNewDiscussion(groupId: string | null = null): Discussion {
        const id = Date.now().toString() + Math.random().toString(36).substring(2);
        const caps = this.getLastCapabilities();
        
        // Force standard mode for new discussions to prevent agent mode bleeding from global state
        if (caps) {
            caps.agentMode = false;
        }

        return {
            id,
            title: 'New Discussion',
            messages:[],
            timestamp: Date.now(),
            groupId,
            plan: null,
            capabilities: caps,
            personalityId: 'default_coder',
            importedSkills:[]
        };
    }

    private saveMutex: Promise<void> = Promise.resolve();

    async saveDiscussion(discussion: Discussion): Promise<void> {
        if (discussion.id.startsWith('temp-') || discussion.id.startsWith('remote-')) return;
        
        this._onDidChangeDiscussions.fire();
        
        // Use a background task to avoid blocking the UI thread for large files
        this.saveMutex = this.saveMutex.then(async () => {
            const content = Buffer.from(JSON.stringify(discussion, null, 2), 'utf8');
            const folders = vscode.workspace.workspaceFolders ||[];
            
            for (const folder of folders) {
                const dir = vscode.Uri.joinPath(folder.uri, '.lollms', 'discussions');
                const filePath = vscode.Uri.joinPath(dir, `${discussion.id}.json`);
                const tempPath = vscode.Uri.joinPath(dir, `${discussion.id}.tmp`);
                
                try {
                    await vscode.workspace.fs.createDirectory(dir);
                    await vscode.workspace.fs.writeFile(tempPath, content);
                    await vscode.workspace.fs.rename(tempPath, filePath, { overwrite: true });
                } catch (e) {
                    console.error(`Failed to save discussion ${discussion.id} in ${folder.name}:`, e);
                    try { await vscode.workspace.fs.delete(tempPath, { useTrash: false }); } catch {}
                }
            }
        }).catch(e => {
            console.error("Error in save mutex chain", e);
        });

        return this.saveMutex;
    }
    
    async getDiscussion(id: string): Promise<Discussion | null> {
        const folders = vscode.workspace.workspaceFolders ||[];
        for (const folder of folders) {
            const filePath = vscode.Uri.joinPath(folder.uri, '.lollms', 'discussions', `${id}.json`);
            try {
                const content = await vscode.workspace.fs.readFile(filePath);
                const jsonString = Buffer.from(content).toString('utf8').trim();
                
                if (!jsonString) {
                    continue;
                }

                const data = JSON.parse(jsonString);
                
                // Migration: Ensure mandatory arrays exist
                if (!data.messages) data.messages =[];
                if (!data.importedSkills) data.importedSkills =[];
                if (!data.capabilities) data.capabilities = this.getLastCapabilities();
                
                return data;
            } catch (error) { 
                // Skip to next folder if not found
            }
        }
        
        Logger.warn(`Discussion file ${id}.json not found. Returning recovery skeleton.`);
        return this.createRecoverySkeleton(id);
    }

    private createRecoverySkeleton(id: string): Discussion {
        return {
            id,
            title: 'Recovered Discussion',
            messages: [{ role: 'system', content: '⚠️ This discussion file was corrupted or empty. Data has been reset to prevent UI crashes.' }],
            timestamp: Date.now(),
            groupId: null,
            capabilities: this.getLastCapabilities(),
            importedSkills: []
        };
    }

    async getAllDiscussions(): Promise<Discussion[]> {
        const folders = vscode.workspace.workspaceFolders || [];
        if (folders.length === 0) return[];

        const resultsMap = new Map<string, Discussion>();

        for (const folder of folders) {
            const dir = vscode.Uri.joinPath(folder.uri, '.lollms', 'discussions');
            try {
                await vscode.workspace.fs.stat(dir);
                const entries = await vscode.workspace.fs.readDirectory(dir);
                const jsonFiles = entries.filter(([name, type]) => 
                    type !== vscode.FileType.Directory && name.endsWith('.json')
                );
                
                for (const [name] of jsonFiles) {
                    try {
                        const id = path.parse(name).name;
                        if (!resultsMap.has(id)) {
                            const discussion = await this.getDiscussion(id);
                            if (discussion && discussion.messages) {
                                resultsMap.set(id, discussion);
                            }
                        }
                    } catch (err) {
                        console.error(`[DiscussionManager] Skipping corrupt discussion: ${name}`, err);
                    }
                }
            } catch (error) {
                // Directory might not exist, skip
            }
        }
        
        return Array.from(resultsMap.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    /**
     * Advanced search across all discussions with wildcard support and snippets.
     */
    async searchDiscussionsAdvanced(query: string): Promise<{id: string, title: string, snippet: string}[]> {
        const discussions = await this.getAllDiscussions();
        const results: {id: string, title: string, snippet: string}[] = [];
        
        // Convert glob-style wildcards to Regex
        // * -> .* , ? -> .
        const escaped = query.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        const regexStr = escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
        const regex = new RegExp(regexStr, 'gi');

        for (const d of discussions) {
            let matchText = d.title || "";
            const content = d.messages.map(m => typeof m.content === 'string' ? m.content : "").join(" ");
            
            const titleMatch = regex.test(d.title);
            const contentMatch = regex.test(content);

            if (titleMatch || contentMatch) {
                let snippet = "";
                if (contentMatch) {
                    regex.lastIndex = 0;
                    const m = regex.exec(content);
                    if (m) {
                        const start = Math.max(0, m.index - 40);
                        const end = Math.min(content.length, m.index + m[0].length + 40);
                        snippet = (start > 0 ? "..." : "") + 
                                  content.substring(start, end).replace(/\n/g, ' ') + 
                                  (end < content.length ? "..." : "");
                        
                        // Highlight the match in snippet for the UI
                        snippet = snippet.replace(regex, (match) => `<mark>${match}</mark>`);
                    }
                } else {
                    snippet = d.messages.length > 0 ? "Match found in title..." : "Empty discussion.";
                }

                results.push({
                    id: d.id,
                    title: d.title.replace(regex, (match) => `<mark>${match}</mark>`),
                    snippet: snippet
                });
            }
        }
        return results;
    }

    async deleteDiscussion(id: string): Promise<void> {
        this.processManager.cancelForDiscussion(id);
        const folders = vscode.workspace.workspaceFolders ||[];
        for (const folder of folders) {
            const filePath = vscode.Uri.joinPath(folder.uri, '.lollms', 'discussions', `${id}.json`);
            try { 
                await vscode.workspace.fs.delete(filePath); 
            } catch (error) {}
        }
        this._onDidChangeDiscussions.fire();
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
        const folders = vscode.workspace.workspaceFolders ||[];
        const groupsMap = new Map<string, DiscussionGroup>();

        for (const folder of folders) {
            const groupsFile = vscode.Uri.joinPath(folder.uri, '.lollms', 'discussion_groups.json');
            try {
                const content = await vscode.workspace.fs.readFile(groupsFile);
                const jsonString = Buffer.from(content).toString('utf8');
                const groups: DiscussionGroup[] = JSON.parse(jsonString);
                for (const g of groups) {
                    if (!groupsMap.has(g.id)) {
                        groupsMap.set(g.id, g);
                    }
                }
            } catch (error) { }
        }
        return Array.from(groupsMap.values());
    }

    async saveGroups(groups: DiscussionGroup[]): Promise<void> {
        const content = Buffer.from(JSON.stringify(groups, null, 2), 'utf8');
        const folders = vscode.workspace.workspaceFolders || [];
        for (const folder of folders) {
            const groupsFile = vscode.Uri.joinPath(folder.uri, '.lollms', 'discussion_groups.json');
            try {
                const dir = vscode.Uri.joinPath(folder.uri, '.lollms');
                await vscode.workspace.fs.createDirectory(dir);
                await vscode.workspace.fs.writeFile(groupsFile, content);
            } catch (e) {
                console.error(`Failed to sync groups to ${folder.name}`, e);
            }
        }
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
        
        const firstUserMessage = discussion.messages.find(m => m.role === 'user');
        if (!firstUserMessage) return null;

        let contentSnippet = "";
        if (typeof firstUserMessage.content === 'string') {
            contentSnippet = firstUserMessage.content.substring(0, 2000);
        } else if (Array.isArray(firstUserMessage.content)) {
            contentSnippet = firstUserMessage.content
                .filter((part: any) => part && part.type === 'text')
                .map((part: any) => part.text || "")
                .join('\n')
                .substring(0, 2000);
        }
    
        const systemPrompt: ChatMessage = {
            role: 'system',
            content: `You are a title generation AI. Create a descriptive, professional title (5 words or less) for the conversation based on the provided user message.
Your response MUST be a valid JSON object: {"title": "..."}.
Output ONLY the JSON.`
        };

        try {
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const titlingModel = config.get<string>('titlingModelName') || discussion.model;

            const rawResponse = await this.lollmsAPI.sendChat([
                systemPrompt, 
                { role: 'user', content: `Generate a title for a discussion starting with: "${contentSnippet}"` }
            ], null, undefined, titlingModel);

            const cleanResponse = stripThinkingTags(rawResponse).trim();
            
            const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.title) return parsed.title.trim().replace(/["']/g, '');
                } catch (e) {}
            }

            const fallbackTitle = cleanResponse.split('\n')[0].trim().replace(/[#{}"']/g, '').substring(0, 60);
            return fallbackTitle || null;

        } catch (error: any) {
            throw error; 
        }
    }
}
