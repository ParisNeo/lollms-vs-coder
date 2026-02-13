import * as vscode from 'vscode';
import { LollmsAPI } from './lollmsAPI';

export class BigDataProcessor {
    constructor(private lollmsAPI: LollmsAPI) {}

    public async processFile(fileUri: vscode.Uri, instruction: string, progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken): Promise<string> {
        const fileContentBytes = await vscode.workspace.fs.readFile(fileUri);
        const fileContent = Buffer.from(fileContentBytes).toString('utf8');

        // Check context size
        const model = this.lollmsAPI.getModelName();
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        let ctxSize = 4096; // Default fallback
        try {
            const sizeRes = await this.lollmsAPI.getContextSize(model);
            if (!sizeRes.isEstimation && sizeRes.context_size > 0) {
                ctxSize = sizeRes.context_size;
            } else {
                 ctxSize = config.get<number>('failsafeContextSize') || 4096;
            }
        } catch {
             ctxSize = config.get<number>('failsafeContextSize') || 4096;
        }

        const tokenEstimate = Math.ceil(fileContent.length / 4);
        const limit = ctxSize * 0.75;

        if (tokenEstimate < limit) {
             return this.processSingleRun(fileContent, instruction, token);
        } else {
             return this.processChunked(fileContent, instruction, ctxSize, progress, token);
        }
    }

    private async processSingleRun(content: string, instruction: string, token?: vscode.CancellationToken): Promise<string> {
        const systemPrompt = "You are a data processing expert. Analyze the provided text according to the user instruction. Return only the processed/synthesized content.";
        const userPrompt = `Instruction: ${instruction}\n\nText:\n${content}`;
        
        const controller = new AbortController();
        if (token) token.onCancellationRequested(() => controller.abort());

        try {
            return await this.lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ], null, controller.signal);
        } catch (e: any) {
            if (e.name === 'AbortError') return "";
            throw e;
        }
    }

    private async processChunked(content: string, instruction: string, ctxSize: number, progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken): Promise<string> {
        // Chunking strategy: 
        // Approx 3.5 chars per token for safety.
        // We aim to use ~50% of context for the chunk to allow room for system prompt + output.
        const charsPerToken = 3.5;
        const safeChunkSize = Math.floor(ctxSize * 0.5 * charsPerToken);
        const overlapChars = Math.floor(safeChunkSize * 0.1);
        
        const chunks: string[] = [];
        if (safeChunkSize <= 0) {
            chunks.push(content);
        } else {
            for (let i = 0; i < content.length; i += (safeChunkSize - overlapChars)) {
                chunks.push(content.substring(i, i + safeChunkSize));
                if (i + safeChunkSize >= content.length) break;
            }
        }

        const summaries: string[] = [];
        const controller = new AbortController();
        if (token) token.onCancellationRequested(() => controller.abort());

        for (let i = 0; i < chunks.length; i++) {
            if (token?.isCancellationRequested) break;
            
            progress?.report({ message: `Processing chunk ${i+1}/${chunks.length}...`, increment: (1/chunks.length)*80 });
            
            const chunk = chunks[i];
            const systemPrompt = "You are a data processing expert. Analyze the provided text chunk according to the user instruction. Provide a concise synthesis/extraction focusing only on relevant info.";
            const userPrompt = `Instruction: ${instruction}\n\nText Chunk (${i+1}/${chunks.length}):\n${chunk}`;

            try {
                const response = await this.lollmsAPI.sendChat([
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ], null, controller.signal);
                summaries.push(response);
            } catch (e: any) {
                if (e.name === 'AbortError') return "";
                throw e;
            }
        }

        if (summaries.length === 0) return "";

        progress?.report({ message: "Synthesizing final result...", increment: 20 });
        
        const combinedSummaries = summaries.join('\n\n--- NEXT CHUNK ---\n\n');
        
        const finalSystemPrompt = "You are a data processing expert. Synthesize the provided chunk analyses into a coherent final document according to the user instruction. Ensure the output is high quality and follows the instruction perfectly.";
        const finalUserPrompt = `Instruction: ${instruction}\n\nChunk Analyses:\n${combinedSummaries}`;
        
        try {
            return await this.lollmsAPI.sendChat([
                { role: 'system', content: finalSystemPrompt },
                { role: 'user', content: finalUserPrompt }
            ], null, controller.signal);
        } catch (e: any) {
            if (e.name === 'AbortError') return "";
            throw e;
        }
    }
}
