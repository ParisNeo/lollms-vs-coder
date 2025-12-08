import * as vscode from 'vscode';
import { ToolDefinition } from "./tool";
import { allTools } from './builtins';
import { McpClient } from '../mcpClient';

export class ToolManager {
    private tools: Map<string, ToolDefinition> = new Map();
    private enabledTools: Set<string> = new Set();
    private mcpClients: McpClient[] = [];

    constructor() {
        this.loadTools();
        this.loadMcpTools();
        this.setDefaultEnabledTools();
    }

    private loadTools() {
        allTools.forEach(tool => {
            this.tools.set(tool.name, tool);
        });
    }

    private async loadMcpTools() {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const mcpServers = config.get<{[key: string]: string}>('mcpServers');

        if (!mcpServers) return;

        for (const [serverName, commandStr] of Object.entries(mcpServers)) {
            try {
                const parts = commandStr.split(' ');
                const command = parts[0];
                const args = parts.slice(1);
                
                const client = new McpClient(command, args);
                await client.connect();
                this.mcpClients.push(client);

                const mcpTools = await client.listTools();
                for (const t of mcpTools) {
                    const toolDef: ToolDefinition = {
                        name: t.name,
                        description: t.description || `MCP Tool from ${serverName}`,
                        isAgentic: true, // MCP tools are usually for agents
                        isDefault: true,
                        parameters: t.inputSchema?.properties ? Object.entries(t.inputSchema.properties).map(([k, v]: [string, any]) => ({
                            name: k,
                            type: v.type,
                            description: v.description || '',
                            required: t.inputSchema.required?.includes(k) || false
                        })) : [],
                        execute: async (params, env, signal) => {
                            try {
                                const result = await client.callTool(t.name, params);
                                // Format result
                                let output = '';
                                if (result.content) {
                                    output = result.content.map((c: any) => c.type === 'text' ? c.text : '[Binary/Image]').join('\n');
                                } else {
                                    output = JSON.stringify(result);
                                }
                                return { success: !result.isError, output };
                            } catch (e: any) {
                                return { success: false, output: `MCP Error: ${e.message}` };
                            }
                        }
                    };
                    this.tools.set(toolDef.name, toolDef);
                    this.enabledTools.add(toolDef.name);
                }
                console.log(`Loaded ${mcpTools.length} tools from MCP server: ${serverName}`);
            } catch (e) {
                console.error(`Failed to load MCP server ${serverName}:`, e);
            }
        }
    }

    private setDefaultEnabledTools() {
        this.enabledTools.clear();
        for (const tool of this.tools.values()) {
            if (tool.isDefault) {
                this.enabledTools.add(tool.name);
            }
        }
    }

    getTool(name: string): ToolDefinition | undefined {
        if (this.enabledTools.has(name)) {
            return this.tools.get(name);
        }
        return undefined;
    }

    getAllTools(): ToolDefinition[] {
        return Array.from(this.tools.values());
    }

    getEnabledTools(): ToolDefinition[] {
        return Array.from(this.enabledTools).map(name => this.tools.get(name)).filter((t): t is ToolDefinition => !!t);
    }
    
    setEnabledTools(toolNames: string[]) {
        this.enabledTools = new Set(toolNames);
    }

    dispose() {
        this.mcpClients.forEach(c => c.dispose());
    }
}
