import fetch, { RequestInit } from 'node-fetch';
import * as https from 'https';

export interface LollmsConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
  disableSslVerification: boolean;
}

export interface ChatMessageContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: {
        url: string;
    };
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ChatMessageContentPart[];
}

export class LollmsAPI {
  private apiUrl: string;
  private apiKey: string;
  private modelName: string;
  private httpsAgent: https.Agent;
  private disableSslVerification: boolean;

  constructor(config: LollmsConfig) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.modelName = config.modelName;
    this.disableSslVerification = config.disableSslVerification;

    this.httpsAgent = new https.Agent({
        rejectUnauthorized: !this.disableSslVerification,
    });
  }

  // Sends a chat completion request to Lollms backend
  async sendChat(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const isHttps = this.apiUrl.startsWith('https');

    const options: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.modelName,
        messages: messages
      }),
      signal: signal,
    };

    if (isHttps) {
      options.agent = this.httpsAgent;
    }

    const response = await fetch(this.apiUrl, options);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Lollms API Error Body:', errorBody);
      throw new Error(`Lollms API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    return data.choices?.[0]?.message?.content || '';
  }
}