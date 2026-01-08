import fetch, { RequestInit, AbortError } from 'node-fetch';
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
  model?: string;
  skipInPrompt?: boolean;
}

export interface TokenizeResponse {
    tokens: number[];
    count: number;
    isEstimation?: boolean; // Added
}

export interface ContextSizeResponse {
    context_size: number;
    isEstimation?: boolean; // Added
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
  private globalState?: vscode.Memento;

  constructor(config: LollmsConfig, globalState?: vscode.Memento) {
    this.config = config;
    this.globalState = globalState;
    this.httpsAgent = this.createHttpsAgent();
    
    try {
        const url = new URL(this.config.apiUrl);
        this.baseUrl = `${url.protocol}//${url.host}`;
        console.log(`[LollmsAPI] Base URL initialized: ${this.baseUrl} (Backend: ${this.config.backendType})`);
    } catch (e) {
        console.error(`[LollmsAPI] Invalid API URL: ${this.config.apiUrl}`, e);
        Logger.error("LollmsAPI initialized with invalid URL", this.config.apiUrl);
        this.baseUrl = "";
    }
  }

  private createHttpsAgent(): https.Agent {
      // Remove quotes if user pasted path with them
      const certPath = this.config.sslCertPath ? this.config.sslCertPath.replace(/^['"]|['"]$/g, '') : '';

      const options: https.AgentOptions = {
          keepAlive: true,
          rejectUnauthorized: !this.config.disableSslVerification,
      };

      if (this.config.disableSslVerification) {
          // Explicitly disable hostname verification when SSL verification is disabled
          options.checkServerIdentity = () => undefined;
          Logger.info("SSL Verification Disabled: Ignoring cert errors and hostname mismatch.");
      }

      if (certPath && fs.existsSync(certPath)) {
          try {
              options.ca = fs.readFileSync(certPath);
              Logger.info(`Loaded custom SSL certificate from: ${certPath}`);
          } catch (e) {
              Logger.error(`Failed to read SSL certificate file: ${certPath}`, e);
          }
      }

      return new https.Agent(options);
  }

  public updateConfig(newConfig: LollmsConfig) {
    const oldUrl = this.config.apiUrl;
    this.config = newConfig;
    this.httpsAgent = this.createHttpsAgent();
    
    try {
        const url = new URL(this.config.apiUrl);
        this.baseUrl = `${url.protocol}//${url.host}`;
        console.log(`[LollmsAPI] Configuration updated. Base URL: ${this.baseUrl}`);
    } catch (error) {
        Logger.error("Invalid API URL updated:", this.config.apiUrl);
        this.baseUrl = ''; 
    }
    
    // Only clear cache if the URL or Key has changed
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
          const models = await this.getModels(true);
          return { 
              success: true, 
              message: `✅ Connection Successful! Found ${models.length} models.`,
              details: `URL: ${this.baseUrl}\nBackend: ${this.config.backendType}`
          };
      } catch (error: any) {
          return { 
              success: false, 
              message: `❌ Connection Failed: ${error.message}`,
              details: error.stack
          };
      }
  }

  public async getModels(forceRefresh: boolean = false): Promise<Array<{ id: string }>> {
    Logger.info(`Fetching models from ${this.baseUrl} (Force: ${forceRefresh}, Backend: ${this.config.backendType})`);

    if (this._cachedModels && this._cachedModels.length > 0 && !forceRefresh) {
        return this._cachedModels;
    }

    if (!forceRefresh && this.globalState) {
        const storedModels = this.globalState.get<Array<{ id: string }>>('lollms_models_cache');
        if (storedModels && storedModels.length > 0) {
            this._cachedModels = storedModels;
            Logger.debug("Using cached models from global state");
            return storedModels;
        }
    }

    if (!this.baseUrl) {
        throw new Error("Invalid API URL");
    }

    let modelsUrl = '';
    
    if (this.config.backendType === 'ollama') {
        modelsUrl = `${this.baseUrl}/api/tags`; // Native Ollama
    } else {
        // OpenAI or Lollms
        modelsUrl = `${this.baseUrl}/v1/models`;
    }

    const isHttps = modelsUrl.startsWith('https');

    const options: RequestInit = {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
    };

    if (isHttps) {
        options.agent = this.httpsAgent;
    }

    try {
        const response = await fetch(modelsUrl, options);
        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        let models: Array<{ id: string }> = [];

        if (this.config.backendType === 'ollama') {
            // Ollama returns { models: [ { name: "model" }, ... ] }
            if (data.models && Array.isArray(data.models)) {
                models = data.models.map((m: any) => ({ id: m.name }));
            }
        } else {
            // OpenAI/Lollms returns { data: [ { id: "model" }, ... ] }
            models = data.data || [];
        }
        
        this._cachedModels = models;
        if (this.globalState) {
            await this.globalState.update('lollms_models_cache', models);
        }
        
        Logger.info(`Successfully fetched ${models.length} models`);
        return models;
    } catch (error: any) {
        Logger.error(`Error fetching models from ${modelsUrl}`, error);
        
        if (this.globalState) {
            const storedModels = this.globalState.get<Array<{ id: string }>>('lollms_models_cache');
            if (storedModels && storedModels.length > 0) {
                Logger.warn("Using stale cached models due to fetch error.");
                this._cachedModels = storedModels;
                return storedModels;
            }
        }
        throw error;
    }
  }

  public async tokenize(text: string, model?: string): Promise<TokenizeResponse> {
    const useExtensions = this.config.useLollmsExtensions;
    console.log(`[LollmsAPI] Tokenize called. Extensions: ${useExtensions}, Backend: ${this.config.backendType}`);
    
    if (!useExtensions) {
        console.log("[LollmsAPI] Lollms extensions disabled. Returning estimated token count.");
        return { count: Math.ceil(text.length / 4), tokens: [], isEstimation: true };
    }

    const tokenizeUrl = `${this.baseUrl}/lollms/v1/tokenize`;
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

    try {
        console.log(`[LollmsAPI] POST ${tokenizeUrl} with model ${modelToSend}`);
        const response = await fetch(tokenizeUrl, options);
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[LollmsAPI] Tokenize failed: ${response.status} ${response.statusText} - ${errorText}`);
            throw new Error(`Status ${response.status}: ${errorText}`);
        }
        const data = await response.json() as TokenizeResponse;
        console.log(`[LollmsAPI] Tokenize success: ${data.count} tokens.`);
        return { ...data, isEstimation: false };
    } catch (e: any) {
        console.warn("[LollmsAPI] Tokenize endpoint failed, falling back to estimation.", e);
        Logger.warn("Tokenize endpoint failed, falling back to estimation.", e);
        return { count: Math.ceil(text.length / 4), tokens: [], isEstimation: true };
    }
  }

  public async getContextSize(model?: string): Promise<ContextSizeResponse> {
    const useExtensions = this.config.useLollmsExtensions;
    console.log(`[LollmsAPI] getContextSize called. Extensions: ${useExtensions}`);
    const defaultSize = 4096;

    if (!useExtensions) {
        console.log("[LollmsAPI] Lollms extensions disabled. Returning default context size.");
        return { context_size: defaultSize, isEstimation: true };
    }

    const contextSizeUrl = `${this.baseUrl}/lollms/v1/context_size`;
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

    try {
        console.log(`[LollmsAPI] POST ${contextSizeUrl}`);
        const response = await fetch(contextSizeUrl, options);
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[LollmsAPI] Context size failed: ${response.status} ${response.statusText} - ${errorText}`);
            throw new Error(`Status ${response.status}: ${errorText}`);
        }
        const data = await response.json() as ContextSizeResponse;
        console.log(`[LollmsAPI] Context Size success: ${data.context_size}`);
        return { ...data, isEstimation: false };
    } catch (e: any) {
        console.warn("[LollmsAPI] Context Size endpoint failed, falling back to default.", e);
        Logger.warn("Context Size endpoint failed, falling back to default.", e);
        return { context_size: defaultSize, isEstimation: true };
    }
  }

  async extractText(base64Data: string, fileName: string): Promise<string> {
    if (!this.config.useLollmsExtensions) {
        return "[Lollms extensions disabled: Cannot extract text from document on server]";
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
        const errorBody = await response.text();
        Logger.error('Lollms Text Extraction API Error:', errorBody);
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

    const modelToSend = modelOverride || this.config.modelName;
    const stream = !!onChunk;
    let chatUrl = '';
    let body: any = {};

    // Filter out messages marked skipInPrompt if the caller didn't do it (safety check)
    // NOTE: Usually caller handles this, but we can double check or rely on caller.
    // Given the caller (ChatPanel) constructs the array, we assume the array passed here is already filtered or prepared.
    // However, if we want to be safe, we can filter here. But `messages` might contain history that *should* be sent.
    // The requirement was "doesn't get sent to the llms when generating".
    // So any message with skipInPrompt=true should be removed from the payload.
    const filteredMessages = messages.filter(m => !m.skipInPrompt);

    if (this.config.backendType === 'ollama') {
        chatUrl = `${this.baseUrl}/api/chat`;
        body = {
            model: modelToSend,
            messages: filteredMessages.map(m => ({ role: m.role, content: m.content })),
            stream: stream
        };
    } else {
        chatUrl = `${this.baseUrl}/v1/chat/completions`;
        body = {
            model: modelToSend,
            messages: filteredMessages.map(({ id, startTime, model, skipInPrompt, ...rest }) => rest),
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

      Logger.debug("Sending chat request", { url: chatUrl, model: modelToSend, stream, backend: this.config.backendType });

      const response = await fetch(chatUrl, options);

      if (!response.ok) {
        const errorBody = await response.text();
        Logger.error('API Error:', errorBody);
        
        let detailedError = `API error: ${response.status} ${response.statusText}.`;
        try {
            const parsedError = JSON.parse(errorBody);
            // Handle various error formats
            if (parsedError.error && parsedError.error.message) {
                detailedError += `\n\nDetails: ${parsedError.error.message}`;
            } else if (parsedError.error) {
                detailedError += `\n\nDetails: ${parsedError.error}`;
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
        
        try {
            for await (const chunk of response.body) {
                if(controller.signal.aborted) {
                    if ((response.body as any).destroy) {
                        (response.body as any).destroy();
                    }
                    throw new AbortError('Request was aborted');
                }

                const chunkText = decoder.decode(chunk as any, { stream: true });

                buffer += chunkText;
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine === '') continue;

                    // OLLAMA NATIVE STREAMING
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
                        } catch (e) {
                            Logger.warn(`Error parsing Ollama stream line: ${trimmedLine}`);
                        }
                    } 
                    // OPENAI / LOLLMS STREAMING
                    else {
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
                            // Raw JSON fallback for non-standard streams
                            try {
                                const parsed = JSON.parse(trimmedLine);
                                let content = parsed.choices?.[0]?.delta?.content;
                                if (!content) content = parsed.content;
                                if (!content) content = parsed.message?.content;
                                if (content) {
                                    fullResponse += content;
                                    onChunk(content);
                                }
                            } catch (e) { 
                                Logger.warn(`Failed to parse raw JSON line: ${trimmedLine}`);
                            }
                        }
                    }
                }
            }
        } catch (streamError) {
             if (streamError instanceof AbortError) throw streamError;
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
    } catch (error) {
        if (error instanceof AbortError) {
            if (timedOut) {
              throw new Error(`Request to API timed out after ${timeoutDuration / 1000} seconds.`);
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
