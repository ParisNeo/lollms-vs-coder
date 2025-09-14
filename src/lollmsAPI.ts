import fetch, { RequestInit, AbortError } from 'node-fetch';
import * as https from 'https';
import { URL } from 'url';

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

  async sendChat(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const chatUrl = `${this.baseUrl}/v1/chat/completions`;
    const isHttps = chatUrl.startsWith('https');
    const apiMessages = messages.map(({ id, ...rest }) => rest);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

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
                throw new Error("Request to Lollms API timed out after 2 minutes.");
            }
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
  }
}