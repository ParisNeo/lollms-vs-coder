import fetch, { RequestInit, AbortError } from 'node-fetch';
import * as https from 'https';
import { URL } from 'url';
import * as vscode from 'vscode';

export interface LollmsConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
  disableSslVerification: boolean;
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string | any[];
}

export interface TokenizeResponse {
    tokens: number[];
    count: number;
}

export interface ContextSizeResponse {
    context_size: number;
}

export class LollmsAPI {
  private config: LollmsConfig;
  private httpsAgent: https.Agent;
  private baseUrl: string;

  constructor(config: LollmsConfig) {
    this.config = config;
    this.httpsAgent = new https.Agent({
        rejectUnauthorized: !this.config.disableSslVerification,
    });
    const url = new URL(this.config.apiUrl);
    this.baseUrl = `${url.protocol}//${url.host}`;
  }

  public getModelName(): string {
      return this.config.modelName;
  }

  public async getModels(): Promise<Array<{ id: string }>> {
    const modelsUrl = `${this.baseUrl}/v1/models`;
    const isHttps = modelsUrl.startsWith('https');

    const options: RequestInit = {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
    };

    if (isHttps) {
        options.agent = this.httpsAgent;
    }

    const response = await fetch(modelsUrl, options);
    if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data.data || [];
  }

  public async tokenize(text: string): Promise<TokenizeResponse> {
    const tokenizeUrl = `${this.baseUrl}/v1/tokenize`;
    const isHttps = tokenizeUrl.startsWith('https');

    const options: RequestInit = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
            model: this.config.modelName,
            text: text
        }),
    };

    if (isHttps) {
        options.agent = this.httpsAgent;
    }

    const response = await fetch(tokenizeUrl, options);
    if (!response.ok) {
        const errorBody = await response.text();
        console.error('Lollms Tokenize API Error Body:', errorBody);
        throw new Error(`Failed to tokenize text: ${response.status} ${response.statusText}`);
    }
    return await response.json() as TokenizeResponse;
  }

  public async getContextSize(): Promise<ContextSizeResponse> {
    const contextSizeUrl = `${this.baseUrl}/v1/context_size`;
    const isHttps = contextSizeUrl.startsWith('https');
    const options: RequestInit = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
            model: this.config.modelName,
        }),
    };

    if (isHttps) {
        options.agent = this.httpsAgent;
    }

    const response = await fetch(contextSizeUrl, options);
    if (!response.ok) {
        const errorBody = await response.text();
        console.error('Lollms Context Size API Error Body:', errorBody);
        throw new Error(`Failed to get context size: ${response.status} ${response.statusText}`);
    }
    return await response.json() as ContextSizeResponse;
  }

  async sendChat(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const chatUrl = `${this.baseUrl}/v1/chat/completions`;
    const isHttps = chatUrl.startsWith('https');
    const apiMessages = messages.map(({ id, ...rest }) => rest);
    
    const controller = new AbortController();
    const timeoutDuration = vscode.workspace.getConfiguration('lollmsVsCoder').get<number>('requestTimeout') || 600000;
    const timeout = setTimeout(() => controller.abort(), timeoutDuration);

    if (signal) {
        signal.addEventListener('abort', () => controller.abort());
    }

    try {
        const options: RequestInit = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
          },
          body: JSON.stringify({
            model: this.config.modelName,
            messages: apiMessages
          }),
          signal: controller.signal,
        };

        if (isHttps) {
          options.agent = this.httpsAgent;
        }

        const response = await fetch(chatUrl, options);

        if (!response.ok) {
          const errorBody = await response.text();
          console.error('Lollms API Error Body:', errorBody);
          throw new Error(`Lollms API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    } catch (error) {
        if (error instanceof AbortError) {
            if (signal?.aborted) {
                throw error;
            } else {
                throw new Error(`Request to Lollms API timed out after ${timeoutDuration / 1000} seconds.`);
            }
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
  }
}