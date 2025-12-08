import * as cp from 'child_process';
import * as readline from 'readline';

export class McpClient {
    private process: cp.ChildProcess | null = null;
    private requestId = 0;
    private pendingRequests = new Map<number, { resolve: (val: any) => void, reject: (err: any) => void }>();
    private isInitialized = false;

    constructor(private command: string, private args: string[] = []) {}

    public async connect(): Promise<void> {
        if (this.process) return;

        this.process = cp.spawn(this.command, this.args, {
            stdio: ['pipe', 'pipe', 'inherit'] // pipe stdin/stdout, inherit stderr
        });

        if (!this.process.stdout || !this.process.stdin) {
            throw new Error('Failed to spawn MCP process with pipes');
        }

        const rl = readline.createInterface({ input: this.process.stdout });
        rl.on('line', (line) => this.handleMessage(line));

        this.process.on('error', (err) => console.error(`MCP [${this.command}] error:`, err));
        this.process.on('exit', (code) => console.log(`MCP [${this.command}] exited with code ${code}`));

        await this.initialize();
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
        } catch (e) {
            // Ignore parse errors or notifications for now
        }
    }

    private send(method: string, params?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.process || !this.process.stdin) return reject(new Error('Not connected'));
            
            const id = this.requestId++;
            this.pendingRequests.set(id, { resolve, reject });
            
            const req = { jsonrpc: '2.0', method, params, id };
            this.process.stdin.write(JSON.stringify(req) + '\n');
        });
    }

    private async initialize() {
        const result = await this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'lollms-vs-coder', version: '0.1.0' }
        });
        
        await this.send('notifications/initialized');
        this.isInitialized = true;
    }

    public async listTools(): Promise<any[]> {
        if (!this.isInitialized) await this.connect();
        const res = await this.send('tools/list');
        return res.tools || [];
    }

    public async callTool(name: string, args: any): Promise<any> {
        if (!this.isInitialized) await this.connect();
        return await this.send('tools/call', { name, arguments: args });
    }

    public dispose() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }
}
