import fetch, { RequestInit } from 'node-fetch';
import * as https from 'https';
import * as fs from 'fs';
import { URL } from 'url';
import * as vscode from 'vscode';
import { Logger } from './logger';

export interface LollmsConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
  disableSslVerification: boolean;
  sslCertPath?: string;
  backendType: 'lollms' | 'openai' | 'ollama' | 'anthropic' | 'google' | 'groq' | 'grok' | 'novitai' | 'openwebui' | 'openrouter';
  useLollmsExtensions: boolean;
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string | any[];
  startTime?: number;
  timestamp?: number;
  model?: string;
  skipInPrompt?: boolean;
}

export interface TokenizeResponse {
    tokens: number[];
    count: number;
    isEstimation?: boolean;
}

export interface ContextSizeResponse {
    context_size: number;
    isEstimation?: boolean;
}

export interface ImageGenerationRequest {
    prompt: string;
    model?: string;
    n?: number;
    quality?: 'standard' | 'hd';
    response_format?: 'url' | 'b64_json';
    size?: string;
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
  private globalState?: vscode.Memento;

  constructor(config: LollmsConfig, globalState?: vscode.Memento) {
    this.config = config;
    this.globalState = globalState;
    this.httpsAgent = this.createHttpsAgent();
    
    if (!this.config.apiKey) {
        this.config.apiKey = process.env.LOLLMS_KEY || '';
    }

    this.baseUrl = this.normalizeBaseUrl(this.config.apiUrl);
    Logger.info(`LollmsAPI Initialized. BaseURL: ${this.baseUrl}, Backend: ${this.config.backendType}`);
  }

  private normalizeBaseUrl(urlStr: string): string {
      try {
          if (!urlStr) return '';
          urlStr = urlStr.trim();
          if (!urlStr.startsWith('http')) {
              urlStr = 'http://' + urlStr;
          }
          const url = new URL(urlStr);
          let cleanUrl = `${url.protocol}//${url.host}${url.pathname}`;
          if (cleanUrl.endsWith('/')) {
              cleanUrl = cleanUrl.slice(0, -1);
          }
          return cleanUrl;
      } catch (e) {
          Logger.error(`Invalid API URL format: ${urlStr}`, e);
          return urlStr;
      }
  }

  private createHttpsAgent(): https.Agent {
      const certPath = this.config.sslCertPath ? this.config.sslCertPath.replace(/^['"]|['"]$/g, '') : '';
      const options: https.AgentOptions = {
          keepAlive: true,
          rejectUnauthorized: !this.config.disableSslVerification,
      };

      if (this.config.disableSslVerification) {
          options.checkServerIdentity = () => undefined;
          Logger.info("SSL Verification Disabled.");
      }

      if (certPath && fs.existsSync(certPath)) {
          try {
              options.ca = fs.readFileSync(certPath);
              Logger.info(`Loaded custom SSL cert: ${certPath}`);
          } catch (e) {
              Logger.error(`Failed to read SSL cert: ${certPath}`, e);
          }
      }

      return new https.Agent(options);
  }

  public updateConfig(newConfig: LollmsConfig) {
    Logger.info("Updating LollmsAPI Config");
    const oldUrl = this.config.apiUrl;
    this.config = newConfig;

    if (!this.config.apiKey) {
        this.config.apiKey = process.env.LOLLMS_KEY || '';
    }

    this.httpsAgent = this.createHttpsAgent();
    this.baseUrl = this.normalizeBaseUrl(this.config.apiUrl);
    
    if (oldUrl !== newConfig.apiUrl && this.globalState) {
        this._cachedModels = null;
        this.globalState.update('lollms_models_cache', undefined);
    }
  }

  public getModelName(): string {
      return this.config.modelName;
  }

  public async testConnection(): Promise<{ success: boolean; message: string; details?: string }> {
      try {
          Logger.info("Testing connection...");
          const models = await this.getModels(true);
          Logger.info(`Connection test success. Models found: ${models.length}`);
          if (models.length > 0) {
            return { 
                success: true, 
                message: `✅ Success! Found ${models.length} models.`,
                details: `URL: ${this.baseUrl}\nBackend: ${this.config.backendType}`
            };
          } else {
            return {
                success: true,
                message: `⚠️ Connected, but 0 models returned.`,
                details: `Server reachable at ${this.baseUrl} but returned empty list.`
            };
          }
      } catch (error: any) {
          Logger.error("Connection test failed", error);
          return { 
              success: false, 
              message: `❌ Failed: ${error.message}`,
              details: error.stack
          };
      }
  }

  private findModelArray(obj: any): any[] | null {
    if (!obj) return null;
    if (Array.isArray(obj)) return obj;
    
    if (obj.data && Array.isArray(obj.data)) return obj.data;
    if (obj.models && Array.isArray(obj.models)) return obj.models;
    
    for (const key of Object.keys(obj)) {
        if (Array.isArray(obj[key]) && obj[key].length > 0) {
            const item = obj[key][0];
            if (typeof item === 'string' || (typeof item === 'object' && (item.id || item.name || item.model))) {
                return obj[key];
            }
        }
    }
    return null;
  }

  public async getModels(forceRefresh: boolean = false): Promise<Array<{ id: string }>> {
    Logger.info(`[getModels] Called. URL: ${this.baseUrl}, Force: ${forceRefresh}`);

    if (this._cachedModels && this._cachedModels.length > 0 && !forceRefresh) {
        return this._cachedModels;
    }

    if (!forceRefresh && this.globalState) {
        const storedModels = this.globalState.get<Array<{ id: string }>>('lollms_models_cache');
        if (storedModels && storedModels.length > 0) {
            this._cachedModels = storedModels;
            return storedModels;
        }
    }

    const backend = this.config.backendType;

    // Anthropic does not provide a models list API
    if (backend === 'anthropic') {
        const models = [{ id: 'claude-3-5-sonnet-latest' }, { id: 'claude-3-opus-latest' }, { id: 'claude-3-haiku-20240307' }];
        this._cachedModels = models;
        return models;
    }

    let url = this.baseUrl;
    let headers: any = { 'Authorization': `Bearer ${this.config.apiKey}` };

    if (backend === 'ollama') {
        url += '/api/tags';
    } else if (backend === 'google') {
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.config.apiKey}`;
        headers = {};
    } else {
        url += '/v1/models';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers,
            signal: controller.signal,
            agent: url.startsWith('https') ? this.httpsAgent : undefined
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        let rawList: any[] = [];

        if (backend === 'ollama') {
            rawList = data.models || [];
        } else if (backend === 'google') {
            rawList = data.models || [];
        } else {
            rawList = this.findModelArray(data) || [];
        }

        const models = rawList.map((m: any) => {
            if (typeof m === 'string') return { id: m };
            return { id: m.id || m.name || m.model || String(m) };
        }).filter(m => m.id);

        this._cachedModels = models;
        if (this.globalState) {
            this.globalState.update('lollms_models_cache', models);
        }
        return models;

    } catch (error: any) {
        Logger.error(`[getModels] Error: ${error.message}`);
        throw error;
    } finally {
        clearTimeout(timeout);
    }
  }

  public async tokenize(text: string, model?: string): Promise<TokenizeResponse> {
    const useExtensions = this.config.useLollmsExtensions && this.config.backendType === 'lollms';
    
    if (!useExtensions) {
        return { count: Math.ceil(text.length / 4), tokens: [], isEstimation: true };
    }

    const tokenizeUrl = `${this.baseUrl}/lollms/v1/tokenize`;
    const isHttps = tokenizeUrl.startsWith('https');

    const modelToSend = model || this.config.modelName;
    const body: any = { text: text };
    if (modelToSend) {
        body.model = modelToSend;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); 

    const options: RequestInit = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
    };

    if (isHttps) {
        options.agent = this.httpsAgent;
    }

    try {
        const response = await fetch(tokenizeUrl, options);
        if (!response.ok) {
            throw new Error(`Status ${response.status}`);
        }
        const data = await response.json() as TokenizeResponse;
        return { ...data, isEstimation: false };
    } catch (e: any) {
        return { count: Math.ceil(text.length / 4), tokens: [], isEstimation: true };
    } finally {
        clearTimeout(timeout);
    }
  }

  public async getContextSize(model?: string): Promise<ContextSizeResponse> {
    const useExtensions = this.config.useLollmsExtensions && this.config.backendType === 'lollms';
    const defaultSize = 4096;

    if (!useExtensions) {
        return { context_size: defaultSize, isEstimation: true };
    }

    const contextSizeUrl = `${this.baseUrl}/lollms/v1/context_size`;
    const isHttps = contextSizeUrl.startsWith('https');

    const modelToSend = model || this.config.modelName;
    const body: any = {};
    if (modelToSend) {
        body.model = modelToSend;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const options: RequestInit = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
    };

    if (isHttps) {
        options.agent = this.httpsAgent;
    }

    try {
        const response = await fetch(contextSizeUrl, options);
        if (!response.ok) {
            throw new Error(`Status ${response.status}`);
        }
        const data = await response.json() as ContextSizeResponse;
        return { ...data, isEstimation: false };
    } catch (e: any) {
        return { context_size: defaultSize, isEstimation: true };
    } finally {
        clearTimeout(timeout);
    }
  }

  async extractText(base64Data: string, fileName: string): Promise<string> {
    if (!this.config.useLollmsExtensions) {
        return "[Lollms extensions disabled]";
    }

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
            filename: fileName
        }),
    };

    if (isHttps) {
        options.agent = this.httpsAgent;
    }

    const response = await fetch(extractUrl, options);
    if (!response.ok) {
        throw new Error(`Failed to extract text: ${response.status}`);
    }
    const data = await response.json();
    return data.text || '';
  }

public async generateImage(prompt: string, options?: { size?: string, quality?: 'standard' | 'hd' }, token?: vscode.CancellationToken): Promise<string> {
    if (!this.baseUrl) {
      throw new Error("Lollms API URL is not configured correctly.");
    }



const imageUrl = `${this.baseUrl}/v1/images/generations`;
const isHttps = imageUrl.startsWith('https');

const requestBody: ImageGenerationRequest = {
    prompt: prompt,
    n: 1,
    response_format: 'b64_json',
    size: options?.size,
    quality: options?.quality
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
            Logger.error('Lollms Image Generation API Error:', errorBody);
            throw new Error(`Lollms Image API error: ${response.status} - ${errorBody}`);
        }

        const data: ImageGenerationResponse = await response.json();

        if (data.data && data.data[0] && data.data[0].b64_json) {
            return data.data[0].b64_json;
        } else {
            throw new Error('API response did not contain valid b64_json image data.');
        }

    } catch (error: any) {
        if (error.name === 'AbortError') {
            if (token?.isCancellationRequested) {
              throw error; 
            } else {
              throw new Error(`Image generation request timed out.`);
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
    const backend = this.config.backendType;
    const model = modelOverride || this.config.modelName;
    const stream = !!onChunk;
    
    let url = this.baseUrl;
    let headers: any = { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}` 
    };
    let body: any = {};

    const sanitizedMessages = messages.filter(m => !m.skipInPrompt).map(m => ({
        role: m.role === 'system' && (backend === 'anthropic' || backend === 'google') ? 'user' : m.role,
        content: m.content
    }));

    if (backend === 'ollama') {
        url += '/api/chat';
        body = { model, messages: sanitizedMessages, stream };
    } else if (backend === 'anthropic') {
        url = 'https://api.anthropic.com/v1/messages';
        headers = {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01'
        };
        // Anthropic requires a specific system prompt field, not a message
        const systemMsg = messages.find(m => m.role === 'system');
        body = {
            model,
            messages: sanitizedMessages.filter(m => m.role !== 'system'),
            system: systemMsg ? systemMsg.content : undefined,
            max_tokens: 4096,
            stream
        };
    } else if (backend === 'google') {
        const method = stream ? 'streamGenerateContent' : 'generateContent';
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}?key=${this.config.apiKey}`;
        headers = { 'Content-Type': 'application/json' };
        body = {
            contents: sanitizedMessages.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }))
        };
    } else {
        url += '/v1/chat/completions';
        body = { model, messages: sanitizedMessages, stream };
    }

    const controller = new AbortController();
    const timeoutDuration = vscode.workspace.getConfiguration('lollmsVsCoder').get<number>('requestTimeout') || 600000;
    const timeout = setTimeout(() => controller.abort(), timeoutDuration);
    if (signal) signal.onabort = () => controller.abort();

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
            agent: url.startsWith('https') ? this.httpsAgent : undefined
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`API Error ${response.status}: ${err}`);
        }

        if (stream && onChunk && response.body) {
            let fullResponse = '';
            let buffer = '';
            const decoder = new TextDecoder();
            
            for await (const chunk of response.body) {
                buffer += decoder.decode(chunk as any, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    let content = '';
                    try {
                        if (backend === 'ollama') {
                            const data = JSON.parse(trimmed);
                            content = data.message?.content || '';
                        } else if (backend === 'anthropic') {
                            if (trimmed.startsWith('data: ')) {
                                const data = JSON.parse(trimmed.substring(6));
                                if (data.type === 'content_block_delta') content = data.delta?.text || '';
                            }
                        } else if (backend === 'google') {
                            // Google returns a JSON array or objects in chunks
                            const data = JSON.parse(trimmed.startsWith('[') ? trimmed.substring(1) : trimmed);
                            content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                        } else {
                            if (trimmed.startsWith('data: ')) {
                                const raw = trimmed.substring(6);
                                if (raw === '[DONE]') continue;
                                const data = JSON.parse(raw);
                                content = data.choices?.[0]?.delta?.content || '';
                            }
                        }
                    } catch (e) {}

                    if (content) {
                        fullResponse += content;
                        onChunk(content);
                    }
                }
            }
            return fullResponse;
        } else {
            const data = await response.json();
            if (backend === 'ollama') return data.message?.content || '';
            if (backend === 'anthropic') return data.content?.[0]?.text || '';
            if (backend === 'google') return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            return data.choices?.[0]?.message?.content || '';
        }
    } catch (error: any) {
        if (error.name === 'AbortError' || error.message === 'AbortError') {
            if (timedOut) {
              throw new Error(`Request timeout.`);
            }
            throw error;
        }
        Logger.error("SendChat Failed", error);
        throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
