import * as cp from 'child_process';
import * as readline from 'readline';
import fetch from 'node-fetch';
import { Logger } from './logger';

export type McpTransport = 'stdio' | 'sse';

export interface McpServerConfig {
    name: string;
    type: McpTransport;
    command?: string; // For stdio
    args?: string[];  // For stdio
    url?: string;     // For SSE
    env?: Record<string, string>;
}

export class McpClient {
    private process: cp.ChildProcess | null = null;
    private requestId = 0;
    private pendingRequests = new Map<number, { resolve: (val: any) => void, reject: (err: any) => void }>();
    private isInitialized = false;
    private buffer = "";

    constructor(private config: McpServerConfig) {}

    public async connect(): Promise<void> {
        if (this.config.type === 'stdio') {
            return this.connectStdio();
        } else {
            return this.connectSSE();
        }
    }

    private async connectStdio(): Promise<void> {
        if (this.process) return;

        const env = { ...process.env, ...this.config.env };
        this.process = cp.spawn(this.config.command!, this.config.args || [], {
            stdio: ['pipe', 'pipe', 'inherit'],
            env
        });

        this.process.stdout?.on('data', (chunk) => {
            this.buffer += chunk.toString();
            this.processBuffer();
        });

        this.process.on('error', (err) => Logger.error(`MCP Stdio [${this.config.name}] error:`, err));
        await this.initialize();
    }

    private async connectSSE(): Promise<void> {
        // Basic SSE discovery and long-polling bridge
        // Most remote MCP servers use a simplified POST-based bridge for tools
        this.isInitialized = true; 
        Logger.info(`MCP Remote [${this.config.name}] initialized at ${this.config.url}`);
    }

    private processBuffer() {
        let boundary = this.buffer.indexOf('\n');
        while (boundary !== -1) {
            const line = this.buffer.slice(0, boundary).trim();
            this.buffer = this.buffer.slice(boundary + 1);
            if (line) this.handleMessage(line);
            boundary = this.buffer.indexOf('\n');
        }
    }

    private handleMessage(line: string) {
        try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined) {
                const pending = this.pendingRequests.get(msg.id);
                if (pending) {
                    this.pendingRequests.delete(msg.id);
                    if (msg.error) pending.reject(msg.error);
                    else pending.resolve(msg.result);
                }
            }
        } catch (e) {}
    }

    private async send(method: string, params?: any): Promise<any> {
        if (this.config.type === 'sse') {
            const res = await fetch(`${this.config.url}/call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.config.env },
                body: JSON.stringify({ method, params })
            });
            return (await res.json()).result;
        }

        return new Promise((resolve, reject) => {
            if (!this.process?.stdin) return reject(new Error('Not connected'));
            const id = this.requestId++;
            this.pendingRequests.set(id, { resolve, reject });
            this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
        });
    }

    private async initialize() {
        await this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'lollms-vs-coder', version: '1.0.0' }
        });
        await this.send('notifications/initialized');
        this.isInitialized = true;
    }

    public async listTools(): Promise<any[]> {
        const res = await this.send('tools/list');
        return res.tools || [];
    }

    public async callTool(name: string, args: any): Promise<any> {
        const result = await this.send('tools/call', { name, arguments: args });
        
        // --- MULTIPART CONTENT HANDLER ---
        // Converts images, text, and data from MCP into a unified Markdown string for the agent
        let output = "";
        if (result.content && Array.isArray(result.content)) {
            for (const part of result.content) {
                if (part.type === 'text') output += part.text + "\n";
                else if (part.type === 'image') {
                    output += `\n![Attached Image](data:${part.mimeType};base64,${part.data})\n`;
                } else if (part.type === 'resource') {
                    output += `\n> Attached Resource: ${part.resource.uri}\n${part.resource.text}\n`;
                }
            }
        } else {
            output = JSON.stringify(result, null, 2);
        }
        return { isError: result.isError, output };
    }

    public dispose() {
        this.process?.kill();
    }
}