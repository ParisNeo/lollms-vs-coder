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
  backendType: 'lollms' | 'openai' | 'ollama';
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
        Logger.info(`[getModels] Returning ${this._cachedModels.length} cached models.`);
        return this._cachedModels;
    }

    if (!forceRefresh && this.globalState) {
        const storedModels = this.globalState.get<Array<{ id: string }>>('lollms_models_cache');
        if (storedModels && storedModels.length > 0) {
            this._cachedModels = storedModels;
            Logger.info(`[getModels] Returning ${storedModels.length} models from global state.`);
            return storedModels;
        }
    }

    if (!this.baseUrl) {
        Logger.error("[getModels] No Base URL.");
        throw new Error("Invalid API URL. Please check settings.");
    }

    let endpoint = '';
    if (this.config.backendType === 'ollama') {
        endpoint = '/api/tags';
    } else {
        endpoint = '/v1/models';
    }

    const primaryUrl = `${this.baseUrl}${endpoint}`;
    Logger.info(`[getModels] Requesting: ${primaryUrl}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); 

    const options: RequestInit = {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
        signal: controller.signal
    };

    if (primaryUrl.startsWith('https')) {
        options.agent = this.httpsAgent;
    }

    try {
        let response: any;
        try {
            response = await fetch(primaryUrl, options);
            Logger.info(`[getModels] Primary response: ${response.status}`);
        } catch (fetchErr: any) {
            Logger.warn(`[getModels] Primary fetch failed: ${fetchErr.message}`);
             if (fetchErr.name !== 'AbortError') {
                 const fallbackEndpoint = this.config.backendType === 'ollama' ? '/v1/models' : '/api/tags';
                 const fallbackUrl = `${this.baseUrl}${fallbackEndpoint}`;
                 Logger.info(`[getModels] Trying fallback: ${fallbackUrl}`);
                 response = await fetch(fallbackUrl, options);
                 Logger.info(`[getModels] Fallback response: ${response.status}`);
             } else {
                 throw fetchErr;
             }
        }

        if (!response.ok) {
            if (response.status === 404) {
                 const fallbackEndpoint = this.config.backendType === 'ollama' ? '/v1/models' : '/api/tags';
                 const fallbackUrl = `${this.baseUrl}${fallbackEndpoint}`;
                 Logger.info(`[getModels] 404 on primary. Trying fallback: ${fallbackUrl}`);
                 response = await fetch(fallbackUrl, options);
            }
        }

        if (!response.ok) {
            const txt = await response.text();
            Logger.error(`[getModels] HTTP Error: ${response.status} - ${txt}`);
            throw new Error(`HTTP ${response.status}: ${txt}`);
        }

        const rawText = await response.text();
        Logger.debug(`[getModels] Raw body length: ${rawText.length}`);
        
        let data;
        try {
            data = JSON.parse(rawText);
        } catch (e) {
            Logger.error(`[getModels] JSON parse error. Raw: ${rawText.substring(0, 200)}`);
            throw new Error(`Invalid JSON from server.`);
        }

        const rawList = this.findModelArray(data);
        if (!rawList) {
            Logger.warn('[getModels] No model array found in response object:', JSON.stringify(data));
            throw new Error('Response JSON does not contain a recognized list of models.');
        }

        const models = rawList.map((m: any) => {
            if (typeof m === 'string') return { id: m };
            return { id: m.id || m.name || m.model || String(m) };
        }).filter(m => m.id);

        this._cachedModels = models;
        if (this.globalState) {
            this.globalState.update('lollms_models_cache', models);
        }
        
        Logger.info(`[getModels] Success. Parsed ${models.length} models.`);
        return models;

    } catch (error: any) {
        Logger.error(`[getModels] Final Error: ${error.message}`);
        
        if (this.globalState) {
            const storedModels = this.globalState.get<Array<{ id: string }>>('lollms_models_cache');
            if (storedModels && storedModels.length > 0) {
                Logger.warn("[getModels] Using stale cache due to error.");
                this._cachedModels = storedModels;
                return storedModels;
            }
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
  }

  public async tokenize(text: string, model?: string): Promise<TokenizeResponse> {
    const useExtensions = this.config.useLollmsExtensions;
    
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
    const useExtensions = this.config.useLollmsExtensions;
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
    if (!this.baseUrl) {
      throw new Error("Lollms API URL is not configured correctly.");
    }

    const modelToSend = modelOverride || this.config.modelName;
    const stream = !!onChunk;
    let chatUrl = '';
    let body: any = {};

    const filteredMessages = messages.filter(m => !m.skipInPrompt);

    const sanitizedMessages = filteredMessages.map(m => ({
        role: m.role,
        content: m.content
    }));

    if (this.config.backendType === 'ollama') {
        chatUrl = `${this.baseUrl}/api/chat`;
        body = {
            model: modelToSend,
            messages: sanitizedMessages,
            stream: stream
        };
    } else {
        chatUrl = `${this.baseUrl}/v1/chat/completions`;
        body = {
            model: modelToSend,
            messages: sanitizedMessages,
            stream: stream
        };
    }

    const isHttps = chatUrl.startsWith('https');
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

      Logger.debug("Sending chat request", { url: chatUrl, model: modelToSend, stream });

      const response = await fetch(chatUrl, options);

      if (!response.ok) {
        const errorBody = await response.text();
        Logger.error('API Error:', errorBody);
        throw new Error(`API error: ${response.status} ${response.statusText} - ${errorBody}`);
      }
      
      if (stream && onChunk && response.body) {
        let fullResponse = '';
        let buffer = '';
        const decoder = new TextDecoder();
        
        try {
            for await (const chunk of response.body) {
                if(controller.signal.aborted) {
                    if ((response.body as any).destroy) {
                        (response.body as any).destroy();
                    }
                    throw new Error('AbortError');
                }

                const chunkText = decoder.decode(chunk as any, { stream: true });

                buffer += chunkText;
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine === '') continue;

                    if (this.config.backendType === 'ollama') {
                        try {
                            const parsed = JSON.parse(trimmedLine);
                            if (parsed.message && parsed.message.content) {
                                fullResponse += parsed.message.content;
                                onChunk(parsed.message.content);
                            }
                            if (parsed.done) {
                                return fullResponse;
                            }
                        } catch (e) { }
                    } else {
                        if (trimmedLine.startsWith('data: ')) {
                            const data = trimmedLine.substring(6).trim();
                            if (data === '[DONE]') return fullResponse;
                            try {
                                const parsed = JSON.parse(data);
                                let content = parsed.choices?.[0]?.delta?.content;
                                if (!content) content = parsed.content; 
                                if (!content) content = parsed.message?.content;
                                if (content) {
                                    fullResponse += content;
                                    onChunk(content);
                                }
                            } catch (e) {
                                Logger.error('Error parsing stream data line:', data);
                            }
                        } else if (trimmedLine.startsWith('{')) {
                            try {
                                const parsed = JSON.parse(trimmedLine);
                                let content = parsed.choices?.[0]?.delta?.content;
                                if (!content) content = parsed.content;
                                if (!content) content = parsed.message?.content;
                                if (content) {
                                    fullResponse += content;
                                    onChunk(content);
                                }
                            } catch (e) { }
                        }
                    }
                }
            }
        } catch (streamError: any) {
             if (streamError.name === 'AbortError' || streamError.message === 'AbortError') throw streamError;
             throw streamError;
        }
        return fullResponse;

      } else {
        const data = await response.json();
        if (this.config.backendType === 'ollama') {
            return data.message?.content || '';
        }
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
