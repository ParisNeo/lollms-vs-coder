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
  startTime?: number;
  model?: string;
}

export interface TokenizeResponse {
    tokens: number[];
    count: number;
}

export interface ContextSizeResponse {
    context_size: number;
}

export interface ImageGenerationRequest {
    prompt: string;
    model?: string;
    n?: number;
    quality?: 'standard' | 'hd';
    response_format?: 'url' | 'b64_json';
    size?: string; // e.g., '1024x1024'
    style?: 'vivid' | 'natural';
}

export interface ImageObject {
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
}

export interface ImageGenerationResponse {
    created: number;
    data: ImageObject[];
}


export class LollmsAPI {
  private config: LollmsConfig;
  private httpsAgent: https.Agent;
  private baseUrl: string;
  private _cachedModels: Array<{ id: string }> | null = null;

  constructor(config: LollmsConfig) {
    this.config = config;
    this.httpsAgent = new https.Agent({
        rejectUnauthorized: !this.config.disableSslVerification,
    });
    const url = new URL(this.config.apiUrl);
    this.baseUrl = `${url.protocol}//${url.host}`;
  }

  public updateConfig(newConfig: LollmsConfig) {
    this.config = newConfig;
    this.httpsAgent = new https.Agent({
        rejectUnauthorized: !this.config.disableSslVerification,
    });
    try {
        const url = new URL(this.config.apiUrl);
        this.baseUrl = `${url.protocol}//${url.host}`;
    } catch (error) {
        console.error("Invalid API URL provided:", this.config.apiUrl);
        this.baseUrl = ''; 
    }
    // Clear cache on config change as URL might have changed
    this._cachedModels = null;
  }

  public getModelName(): string {
      return this.config.modelName;
  }

  public async getModels(forceRefresh: boolean = false): Promise<Array<{ id: string }>> {
    if (this._cachedModels && !forceRefresh) {
        return this._cachedModels;
    }

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
    this._cachedModels = data.data || [];
    return this._cachedModels!;
  }

  public async tokenize(text: string, model?: string): Promise<TokenizeResponse> {
    const tokenizeUrl = `${this.baseUrl}/v1/tokenize`;
    const isHttps = tokenizeUrl.startsWith('https');

    const modelToSend = model || this.config.modelName;
    const body: any = { text: text };
    if (modelToSend) {
        body.model = modelToSend;
    }

    const options: RequestInit = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body),
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

  public async getContextSize(model?: string): Promise<ContextSizeResponse> {
    const contextSizeUrl = `${this.baseUrl}/v1/context_size`;
    const isHttps = contextSizeUrl.startsWith('https');

    const modelToSend = model || this.config.modelName;
    const body: any = {};
    if (modelToSend) {
        body.model = modelToSend;
    }

    const options: RequestInit = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body),
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

  async extractText(base64Data: string, fileName: string): Promise<string> {
    const extractUrl = `${this.baseUrl}/v1/extract_text`;
    const isHttps = extractUrl.startsWith('https');
    const options: RequestInit = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
            file: base64Data,
            filename: fileName // Pass filename for type detection on the backend
        }),
    };

    if (isHttps) {
        options.agent = this.httpsAgent;
    }

    const response = await fetch(extractUrl, options);
    if (!response.ok) {
        const errorBody = await response.text();
        console.error('Lollms Text Extraction API Error:', errorBody);
        throw new Error(`Failed to extract text: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data.text || '';
}

  public async generateImage(prompt: string, token?: vscode.CancellationToken): Promise<string> {
    if (!this.baseUrl) {
      throw new Error("Lollms API URL is not configured correctly.");
    }
    const imageUrl = `${this.baseUrl}/v1/images/generations`;
    const isHttps = imageUrl.startsWith('https');
    
    const requestBody: ImageGenerationRequest = {
        prompt: prompt,
        n: 1,
        response_format: 'b64_json',
        // Relying on server defaults for model, size, etc.
    };

    const controller = new AbortController();
    const timeoutDuration = vscode.workspace.getConfiguration('lollmsVsCoder').get<number>('requestTimeout') || 600000;
    const timeout = setTimeout(() => controller.abort(), timeoutDuration);

    if (token) {
        token.onCancellationRequested(() => controller.abort());
    }

    try {
        const options: RequestInit = {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.config.apiKey}`
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          };
    
        if (isHttps) {
            options.agent = this.httpsAgent;
        }

        const response = await fetch(imageUrl, options);

        if (!response.ok) {
            const errorBody = await response.text();
            console.error('Lollms Image Generation API Error Body:', errorBody);
            throw new Error(`Lollms Image API error: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data: ImageGenerationResponse = await response.json();

        if (data.data && data.data[0] && data.data[0].b64_json) {
            return data.data[0].b64_json;
        } else {
            throw new Error('API response did not contain valid b64_json image data.');
        }

    } catch (error) {
        if (error instanceof AbortError) {
            if (token?.isCancellationRequested) {
              throw error; // Propagate user-initiated abort
            } else {
              throw new Error(`Image generation request timed out after ${timeoutDuration / 1000} seconds.`);
            }
          }
          throw error;
    } finally {
        clearTimeout(timeout);
    }
  }

  async sendChat(
    messages: ChatMessage[],
    onChunk?: ((chunk: string) => void) | null,
    signal?: AbortSignal,
    modelOverride?: string
  ): Promise<string> {
    if (!this.baseUrl) {
      throw new Error("Lollms API URL is not configured correctly. Please check the settings.");
    }
    const chatUrl = `${this.baseUrl}/v1/chat/completions`;
    const isHttps = chatUrl.startsWith('https');
    const apiMessages = messages.map(({ id, startTime, model, ...rest }) => rest);
    const stream = !!onChunk;

    const controller = new AbortController();
    const timeoutDuration = vscode.workspace.getConfiguration('lollmsVsCoder').get<number>('requestTimeout') || 600000;
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutDuration);

    if (signal) {
      signal.onabort = () => controller.abort();
    }

    try {
      const modelToSend = modelOverride || this.config.modelName;
      const body: any = {
          messages: apiMessages,
          stream: stream
      };
      if (modelToSend) {
          body.model = modelToSend;
      }
      
      const options: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      };

      if (isHttps) {
        options.agent = this.httpsAgent;
      }

      const response = await fetch(chatUrl, options);

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('Lollms API Error Body:', errorBody);
        // Construct a more informative error message
        let detailedError = `Lollms API error: ${response.status} ${response.statusText}.`;
        try {
            const parsedError = JSON.parse(errorBody);
            if (parsedError.error && parsedError.error.message) {
                detailedError += `\n\nDetails: ${parsedError.error.message}`;
            } else {
                detailedError += `\n\nFull Response: ${errorBody}`;
            }
        } catch (e) {
            detailedError += `\n\nRaw Response: ${errorBody}`;
        }
        throw new Error(detailedError);
      }
      
      if (stream && onChunk && response.body) {
        let fullResponse = '';
        let buffer = '';
        const decoder = new TextDecoder();
        
        for await (const chunk of response.body) {
            if(controller.signal.aborted) {
                (response.body as any).destroy();
                throw new AbortError('Request was aborted');
            }
            buffer += decoder.decode(chunk as any, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep the last, possibly incomplete line

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine === '') continue; // Skip empty lines

                if (trimmedLine.startsWith('data: ')) {
                    const data = trimmedLine.substring(6).trim();
                    if (data === '[DONE]') {
                        return fullResponse;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) {
                            fullResponse += content;
                            onChunk(content);
                        }
                    } catch (e) {
                        console.error('Error parsing stream data line:', data, e);
                    }
                }
            }
        }
        return fullResponse;

      } else {
        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
      }
    } catch (error) {
        if (error instanceof AbortError) {
            if (timedOut) {
              throw new Error(`Request to Lollms API timed out after ${timeoutDuration / 1000} seconds.`);
            }
            // If not timedOut, it must be an external abort signal
            throw error;
        }
        throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
