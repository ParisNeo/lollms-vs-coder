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
  backendType: 'lollms' | 'openai' | 'ollama' | 'anthropic' | 'google' | 'groq' | 'grok' | 'novitai' | 'openwebui' | 'openrouter' | 'perplexity' | 'together';
  useLollmsExtensions: boolean;
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string | any[];
  startTime?: number;
  timestamp?: number;
  model?: string;
  personalityName?: string; // Add this field
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

            // Heuristic: If it lacks scheme, add https for cloud (Moonshot/Kimi), http for localhost
            if (!urlStr.startsWith('http')) {
                if (urlStr.includes('localhost') || urlStr.includes('127.0.0.1')) {
                    urlStr = 'http://' + urlStr;
                } else {
                    urlStr = 'https://' + urlStr;
                }
            }

            const url = new URL(urlStr);
            let cleanUrl = `${url.protocol}//${url.host}${url.pathname}`;

            // Remove trailing slash only. Version logic moved to getModels to prevent logic clashing.
            cleanUrl = cleanUrl.replace(/\/+$/, '');

            return cleanUrl;
        } catch (e) {
            Logger.error(`Invalid API URL format: ${urlStr}`, e);
            return urlStr;
        }
    }

  private createHttpsAgent(): https.Agent {
      const certPath = this.config.sslCertPath ? this.config.sslCertPath.replace(/^['"]|['"]$/g, '') : '';
      
      // Mitigation: If user explicitly disabled SSL, force the Node environment to respect it.
      // This helps with dependencies that might ignore the custom agent.
      if (this.config.disableSslVerification) {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
          Logger.warn("SSL Verification Disabled (NODE_TLS_REJECT_UNAUTHORIZED=0). TLS connections are now insecure.");
      } else {
          // Re-enable if it was previously disabled
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
      }

      const options: https.AgentOptions = {
          keepAlive: true,
          rejectUnauthorized: !this.config.disableSslVerification,
      };

      if (this.config.disableSslVerification) {
          // Additional layer of bypass for some node versions
          options.checkServerIdentity = () => undefined;
      }

      if (certPath && fs.existsSync(certPath)) {
          try {
              const stat = fs.statSync(certPath);
              if (stat.isFile()) {
                  const certBuffer = fs.readFileSync(certPath);
                  options.ca = certBuffer;
                  Logger.info(`Loaded custom SSL cert buffer: ${certPath}`);
              } else {
                  Logger.warn(`SSL Cert Path is a directory, skipping: ${certPath}`);
              }
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
        url = url.endsWith('/api/tags') ? url : (url.endsWith('/api') ? `${url}/tags` : `${url}/api/tags`);
    } else if (backend === 'openwebui') {
        url = url.endsWith('/models') ? url : `${url}/models`;
    } else if (backend === 'google') {
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.config.apiKey}`;
        headers = {};
    } else {
        // Standard OpenAI-compatible path joining
        // Prevents double-versioning (/v1/v1) while ensuring standard cloud paths work
        const pathLower = url.toLowerCase();
        if (pathLower.endsWith('/v1') || pathLower.endsWith('/v1/')) {
            url = url.replace(/\/+$/, '') + '/models';
        } else {
            url = url.replace(/\/+$/, '') + '/v1/models';
        }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
        const isHttps = url.startsWith('https');
        const response = await fetch(url, {
            method: 'GET',
            headers,
            signal: controller.signal,
            // Use the agent for all HTTPS calls regardless of backend
            agent: isHttps ? this.httpsAgent : undefined
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
    const backend = this.config.backendType;
    const modelName = model || this.config.modelName;

    // 1. High-Precision Lollms Tokenizer API
    if (this.config.useLollmsExtensions && backend === 'lollms') {
        const tokenizeUrl = `${this.baseUrl}/lollms/v1/tokenize`;
        const isHttps = tokenizeUrl.startsWith('https');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        try {
            const response = await fetch(tokenizeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.apiKey}` },
                body: JSON.stringify({ model: modelName, text: text }),
                signal: controller.signal,
                agent: isHttps ? this.httpsAgent : undefined
            });
            if (response.ok) {
                return await response.json() as TokenizeResponse;
            }
        } catch (e) { } finally { clearTimeout(timeout); }
    }

    // 2. Advanced Heuristic Estimation
    // Code often uses more tokens (approx 2.5-3 chars/token) than prose (approx 4 chars/token).
    // We scan for common code indicators.
    const hasCode = text.includes('{') || text.includes('def ') || text.includes('function ') || text.includes('import ');
    const multiplier = hasCode ? 0.35 : 0.28; // Inverse of chars/token
    
    const count = Math.ceil(text.length * multiplier);

    return { count, tokens: [], isEstimation: true };
  }


  public async getContextSize(model?: string): Promise<ContextSizeResponse> {
    const useExtensions = this.config.useLollmsExtensions && this.config.backendType === 'lollms';
    const defaultSize = 128000;

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

  /**
   * Enhanced extraction that returns both text and a list of extracted images (base64).
   */
  async extractPDFVisual(base64Data: string, fileName: string, extractImages: boolean = true, allPagesAsImages: boolean = false): Promise<{ text: string, images?: { name: string, data: string }[] }> {
    if (!this.config.useLollmsExtensions) {
        throw new Error("Lollms extensions disabled");
    }

    const extractUrl = `${this.baseUrl}/v1/extract_pdf_full`; // Correct Lollms v1 extension endpoint
    const isHttps = extractUrl.startsWith('https');
    
    const options: RequestInit = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
            file: base64Data,
            filename: fileName,
            extract_images: extractImages,
            all_pages_as_images: allPagesAsImages
        }),
    };

    const response = await fetch(extractUrl, {
        ...options,
        agent: isHttps ? this.httpsAgent : undefined
    });

    if (!response.ok) {
        // Fallback to standard text extraction if visual one fails
        if (allPagesAsImages) {
            throw new Error(`Server returned ${response.status}. Ensure Lollms backend is updated and supports 'extract_pdf_full'.`);
        }
        const text = await this.extractText(base64Data, fileName);
        return { text };
    }

    return await response.json();
  }

  async extractText(base64Data: string, fileName: string): Promise<string> {
    if (!this.config.useLollmsExtensions) return "[Lollms extensions disabled]";

    const extractUrl = `${this.baseUrl}/v1/extract_text`;
    const isHttps = extractUrl.startsWith('https');
    const options: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ file: base64Data, filename: fileName }),
    };

    const response = await fetch(extractUrl, { ...options, agent: isHttps ? this.httpsAgent : undefined });
    if (!response.ok) throw new Error(`Failed to extract text: ${response.status}`);
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
    
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutDuration);

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
            if (timedOut) {
              throw new Error(`Image generation request timed out.`);
            }
            throw error; 
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
    modelOverride?: string,
    options?: { thinking?: boolean, capabilities?: any, temperature?: number }
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

    // =========================================================================
    // 🛡️ FINAL API OUTBOUND LOG (DEBUG)
    // =========================================================================
    console.log(`%c[LoLLMs API] >>> Request to Backend (${backend})`, 'color: #00ff00; font-weight: bold;');
    console.log(`Model: ${model} | Stream: ${!!onChunk}`);
    console.log(`Total Sequence Length: ${sanitizedMessages.length} messages`);
    
    sanitizedMessages.forEach((msg, idx) => {
        const role = msg.role.toUpperCase();
        // Fixed: If content is already an object/array (multipart), don't stringify it here, 
        // just get a preview for the logs.
        const contentPreview = typeof msg.content === 'string' ? msg.content : "[Multipart/Vision Content]";
        const len = typeof msg.content === 'string' ? msg.content.length : 0;
        
        if (len > 800 && typeof msg.content === 'string') {
            console.log(`  [${idx}] ${role} (${len} chars): ${msg.content.substring(0, 400)} ... [TRUNCATED] ... ${msg.content.substring(len - 400)}`);
        } else {
            console.log(`  [${idx}] ${role} (${len} chars): ${contentPreview}`);
        }
    });
    console.log(`%c[LoLLMs API] <<< End of Request Payload`, 'color: #00ff00; font-weight: bold;');
    // =========================================================================

    const controller = new AbortController();
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    
    // Resolve timeout values from capabilities or global config
    // 0 = Infinity (no timer started)
    const ttftTimeoutValue = options?.capabilities?.ttftTimeout ?? config.get<number>('requestTimeout') ?? 0;
    const interTokenTimeoutValue = options?.capabilities?.interTokenTimeout ?? 0;
    
    let timedOut = false;
    let firstTokenReceived = false;
    let activeTimer: NodeJS.Timeout | undefined;

    const resetTimer = (ms: number) => {
        if (activeTimer) clearTimeout(activeTimer);
        if (ms <= 0) return; // Infinity
        activeTimer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, ms);
    };

    // Start waiting for the very first token
    resetTimer(ttftTimeoutValue);

    if (signal) {
        signal.addEventListener('abort', () => {
            if (activeTimer) clearTimeout(activeTimer);
            controller.abort();
        });
    }
    
    // PRIORITY: 
    // 1. Explicit option passed by ChatPanel (The Badge)
    // 2. Global Setting fallback
    const isThinkingActive = options?.thinking !== undefined ? options.thinking : (config.get<boolean>('lollmsVsCoder.thinkingMode') || false);
    
    const reasoningEffort = config.get<string>('lollmsVsCoder.reasoningEffort') || 'medium';
    const thinkingBudget = config.get<number>('lollmsVsCoder.thinkingBudget') || 16000;

    if (backend === 'ollama') {
        url += '/api/chat';
        body = { 
            model, 
            messages: sanitizedMessages, 
            stream,
            options: {
                temperature: options?.temperature
            }
        };
        // Only inject the 'think' key if explicitly requested to avoid 500 on standard models
        if (isThinkingActive) {
            body.think = true;
        }
    } else if (backend === 'anthropic') {
        url = 'https://api.anthropic.com/v1/messages';
        headers = {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey,
            'anthropic-version': '2023-06-01'
        };
        const systemMsg = messages.find(m => m.role === 'system');
        body = {
            model,
            messages: sanitizedMessages.filter(m => m.role !== 'system'),
            system: systemMsg ? systemMsg.content : undefined,
            stream
        };
        if (isThinkingActive) {
            body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
        }
    } else if (backend === 'openai' || backend === 'lollms') {
        url += '/v1/chat/completions';
        body = { 
            model, 
            messages: sanitizedMessages, 
            stream,
            temperature: options?.temperature
        };
        if (isThinkingActive) {
            // OpenAI o1/o3 style
            body.max_completion_tokens = thinkingBudget;
            body.reasoning_effort = reasoningEffort;
            // DeepSeek Reasoner style
            body.thinking = { type: "enabled" };
        } else {
            body.include_reasoning = false;
        }
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

        // --- GOOGLE SEARCH GROUNDING ---
        if (options?.capabilities?.webSearch) {
            body.tools = [{ googleSearchRetrieval: {} }];
        }
    } else if (backend === 'perplexity') {
        // Perplexity uses OpenAI-compatible endpoint but distinct URL
        url = 'https://api.perplexity.ai/chat/completions';
        headers = { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}` 
        };
        body = { model, messages: sanitizedMessages, stream };
    } else if (backend === 'openwebui') {
        // OpenWebUI serves OpenAI API at /api/chat/completions
        // We assume the user provides the base URL ending in /api
        url += '/chat/completions';
        body = { model, messages: sanitizedMessages, stream };
    } else {
        url += '/v1/chat/completions';
        body = { model, messages: sanitizedMessages, stream };
    }



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
                if (!firstTokenReceived) {
                    firstTokenReceived = true;
                }
                // Once we have data, switch to inter-token timeout
                resetTimer(interTokenTimeoutValue);

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
                        if (typeof onChunk === 'function') {
                            onChunk(content);
                        }
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
              const msg = firstTokenReceived 
                ? `Generation stalled (Inter-token timeout: ${interTokenTimeoutValue}ms)` 
                : `Request timed out waiting for first token (TTFT: ${ttftTimeoutValue}ms)`;
              throw new Error(msg);
            }
            throw error;
        }
        Logger.error("SendChat Failed", error);
        throw error;
    } finally {
      if (activeTimer) clearTimeout(activeTimer);
    }
  }
}
