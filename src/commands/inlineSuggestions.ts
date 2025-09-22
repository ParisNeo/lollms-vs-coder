import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from '../lollmsAPI';
import { getProcessedSystemPrompt } from '../utils';

export class LollmsInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private api: LollmsAPI;
    private debounceTimer: NodeJS.Timeout | undefined;
    private lastRequestController: AbortController | null = null;

    constructor(api: LollmsAPI) {
        this.api = api;
    }

    public async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | undefined> {

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        if (this.lastRequestController) {
            this.lastRequestController.abort();
        }
        this.lastRequestController = new AbortController();
        const signal = this.lastRequestController.signal;

        return new Promise((resolve) => {
            this.debounceTimer = setTimeout(() => {
                if (token.isCancellationRequested || signal.aborted) {
                    resolve(undefined);
                    return;
                }

                const lineText = document.lineAt(position.line).text;
                if (!lineText.trim()) {
                    resolve(undefined);
                    return;
                }
                
                this.getCompletion(document, position, signal)
                    .then(completion => {
                        if (completion) {
                            const lineEnd = document.lineAt(position.line).range.end;
                            const rangeToReplace = new vscode.Range(position, lineEnd);
                            resolve([new vscode.InlineCompletionItem(completion, rangeToReplace)]);
                        } else {
                            resolve(undefined);
                        }
                    })
                    .catch(() => {
                        resolve(undefined);
                    });
            }, 500);
        });
    }

    public async triggerSuggestion(document: vscode.TextDocument, position: vscode.Position): Promise<string | undefined> {
        if (this.lastRequestController) {
            this.lastRequestController.abort();
        }
        this.lastRequestController = new AbortController();
        return this.getCompletion(document, position, this.lastRequestController.signal);
    }

    private async getCompletion(document: vscode.TextDocument, position: vscode.Position, signal: AbortSignal): Promise<string | undefined> {
        const textBefore = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const textAfter = document.getText(new vscode.Range(position, new vscode.Position(document.lineCount, document.getText().length)));

        const maxChars = 2000;
        const truncatedBefore = textBefore.slice(-maxChars);
        const truncatedAfter = textAfter.slice(0, maxChars);

        const prompt = `You are a code completion AI. Your task is to complete the single line of code the user is currently typing.
Provide only the code that should come after the cursor. Do not repeat the code the user has already typed.
---
Code before cursor:
${truncatedBefore}
---
Code after cursor:
${truncatedAfter}`;

        const chatPersonaPrompt = getProcessedSystemPrompt('chat');
        const messages: ChatMessage[] = [];
        if (chatPersonaPrompt) {
            messages.push({ role: 'system', content: chatPersonaPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        try {
            const response = await this.api.sendChat(messages, signal);
            const firstLine = response.split('\n')[0].trim();
            
            const lineSuffix = document.lineAt(position.line).text.substring(position.character);
            if (firstLine && !lineSuffix.startsWith(firstLine)) {
                return firstLine;
            }
            return undefined;

        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log('Lollms suggestion request aborted.');
            } else {
                console.error('Lollms inline suggestion error:', error);
            }
            return undefined;
        }
    }
}