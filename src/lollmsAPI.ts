import fetch, { RequestInit } from 'node-fetch';
import * as https from 'https';
import * as fs from 'fs';
import { URL } from 'url';
import * as vscode from 'vscode';
import { Logger } from './logger';
import { stripThinkingTags } from './utils';

export interface ServerBinding {
  id?: string;
  name: string;
  apiUrl: string;
  apiKey?: string;
  backendType: 'lollms' | 'openai' | 'ollama' | 'anthropic' | 'google' | 'groq' | 'grok' | 'novitai' | 'openwebui' | 'openrouter' | 'perplexity' | 'together';
  disableSslVerification?: boolean;
  sslCertPath?: string;
  useLollmsExtensions?: boolean;
  enabled?: boolean;
}

export interface LollmsConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
  ttiModelName?: string;
  disableSslVerification: boolean;
  sslCertPath?: string;
  backendType: 'lollms' | 'openai' | 'ollama' | 'anthropic' | 'google' | 'groq' | 'grok' | 'novitai' | 'openwebui' | 'openrouter' | 'perplexity' | 'together';
  useLollmsExtensions: boolean;
  serverBindings?: ServerBinding[];
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
    isUserDefined?: boolean; // New flag
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

const FormData = require('form-data');

export class LollmsAPI {
  private config: LollmsConfig;
  private httpsAgent: https.Agent;
  private baseUrl: string;
  private _cachedModels: Array<{ id: string; name?: string; server?: string }> | null = null;
  private _cachedContextSizes: Map<string, number> = new Map();
  private _modelToBindingMap: Map<string, { binding: ServerBinding; targetModel: string; rawModel?: string }> = new Map();
  private _rawModelToBindingMap: Map<string, { binding: ServerBinding; targetModel: string; rawModel?: string }> = new Map();
  private _bindingAgents: Map<string, https.Agent> = new Map();
  private globalState?: vscode.Memento;

  constructor(config: LollmsConfig, globalState?: vscode.Memento) {
    this.config = config;
    this.globalState = globalState;

    // Tier 1: Global Force Disable
    if (this.config.disableSslVerification) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        Logger.warn("[SSL] Global SSL verification disabled via NODE_TLS_REJECT_UNAUTHORIZED=0");
    } else {
        // Reset to default if user re-enables it
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
    }

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

      const options: https.AgentOptions = {
          keepAlive: true,
          rejectUnauthorized: !this.config.disableSslVerification
      };

      // Tier 2: Enhanced Bypass for Self-Signed/Local Certs
      if (this.config.disableSslVerification) {
          options.checkServerIdentity = () => undefined;
          // Some environments require specific ciphers for self-signed legacy servers
          options.ciphers = 'ALL';
          // Ensure we allow unsafe legacy renegotiation which is common in local proxy setups
          (options as any).secureOptions = require('constants').SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION;
      }

      if (certPath && fs.existsSync(certPath)) {
          try {
              const stat = fs.statSync(certPath);
              if (stat.isFile()) {
                  const certBuffer = fs.readFileSync(certPath);
                  // If user provides a cert, we treat it as an authoritative CA
                  options.ca = certBuffer;
                  // If they provided a cert, they likely want to verify against IT specifically
                  // unless they also checked "Disable Verification"
                  Logger.info(`[SSL] Custom CA injected into Agent: ${certPath}`);
              }
          } catch (e) {
              Logger.error(`[SSL] Failed to load cert file: ${certPath}`, e);
          }
      }

      return new https.Agent(options);
  }

  public updateConfig(newConfig: LollmsConfig) {
    Logger.info("Updating LollmsAPI Config with cumulative bindings support");
    const oldUrl = this.config.apiUrl;
    const oldBackend = this.config.backendType;
    const oldKey = this.config.apiKey;
    const oldBindings = JSON.stringify(this.config.serverBindings || []);
    const newBindings = JSON.stringify(newConfig.serverBindings || []);

    this.config = newConfig;

    if (!this.config.apiKey) {
        this.config.apiKey = process.env.LOLLMS_KEY || '';
    }

    this.httpsAgent = this.createHttpsAgent();
    this.baseUrl = this.normalizeBaseUrl(this.config.apiUrl);
    this._bindingAgents.clear();

    const isDifferent = oldUrl !== newConfig.apiUrl || oldBackend !== newConfig.backendType || oldKey !== newConfig.apiKey || oldBindings !== newBindings;
    if (isDifferent) {
        this._cachedModels = null;
        this._cachedContextSizes.clear();
        this._modelToBindingMap.clear();
        this._rawModelToBindingMap.clear();
        if (this.globalState) {
            this.globalState.update('lollms_models_cache', undefined);
        }
    }
  }

  public getAllActiveBindings(): ServerBinding[] {
    const list: ServerBinding[] = [];

    // 1. Primary configured binding
    if (this.config.apiUrl && this.config.apiUrl.trim()) {
        const primaryName = this.config.backendType === 'lollms' ? 'Lollms (Primary)' : `${this.config.backendType.toUpperCase()} (Primary)`;
        list.push({
            id: 'primary',
            name: primaryName,
            apiUrl: this.config.apiUrl,
            apiKey: this.config.apiKey,
            backendType: this.config.backendType,
            disableSslVerification: this.config.disableSslVerification,
            sslCertPath: this.config.sslCertPath,
            useLollmsExtensions: this.config.useLollmsExtensions,
            enabled: true
        });
    }

    // 2. Extra configured bindings from connectionProfiles
    const extra = this.config.serverBindings || [];
    for (const b of extra) {
        if (!b || !b.apiUrl || !b.apiUrl.trim() || b.enabled === false) continue;
        const normUrl = this.normalizeBaseUrl(b.apiUrl);
        // Avoid adding duplicate primary server with identical backend
        const isDuplicatePrimary = list.length > 0 && 
            this.normalizeBaseUrl(list[0].apiUrl).toLowerCase() === normUrl.toLowerCase() && 
            list[0].backendType === b.backendType;

        if (!isDuplicatePrimary) {
            list.push({
                ...b,
                id: b.id || `binding_${b.name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
                name: b.name.trim() || `Server ${list.length + 1}`
            });
        }
    }

    return list;
  }

  public getAgentForBinding(binding: ServerBinding): https.Agent | undefined {
    const isHttps = binding.apiUrl.startsWith('https');
    if (!isHttps) return undefined;

    const key = `${binding.apiUrl}_${binding.disableSslVerification}_${binding.sslCertPath || ''}`;
    if (this._bindingAgents.has(key)) {
        return this._bindingAgents.get(key);
    }

    const options: https.AgentOptions = {
        keepAlive: true,
        rejectUnauthorized: !binding.disableSslVerification
    };

    if (binding.disableSslVerification) {
        options.checkServerIdentity = () => undefined;
        options.ciphers = 'ALL';
        (options as any).secureOptions = require('constants').SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION;
    }

    const certPath = binding.sslCertPath ? binding.sslCertPath.replace(/^['"]|['"]$/g, '') : '';
    if (certPath && fs.existsSync(certPath)) {
        try {
            options.ca = fs.readFileSync(certPath);
        } catch {}
    }

    const agent = new https.Agent(options);
    this._bindingAgents.set(key, agent);
    return agent;
  }

  public resolveBindingForModel(modelName?: string): { binding: ServerBinding; targetModel: string } {
    const raw = (modelName || this.config.modelName || "").trim();
    const bindings = this.getAllActiveBindings();
    const fallbackBinding = bindings.length > 0 ? bindings[0] : {
        id: 'default',
        name: 'Default',
        apiUrl: this.config.apiUrl,
        apiKey: this.config.apiKey,
        backendType: this.config.backendType,
        disableSslVerification: this.config.disableSslVerification,
        sslCertPath: this.config.sslCertPath,
        useLollmsExtensions: this.config.useLollmsExtensions
    };
    const defaultModel = (raw || this.config.modelName || "default").trim();

    if (!raw) {
        return { binding: fallbackBinding, targetModel: defaultModel };
    }

    // 1. Explicit namespacing format: "ServerName::modelName"
    if (raw.includes('::')) {
        const delimiterIdx = raw.indexOf('::');
        const bindingNameOrId = raw.substring(0, delimiterIdx).trim();
        const targetModel = raw.substring(delimiterIdx + 2).trim();

        const found = bindings.find(b => 
            b.name.toLowerCase() === bindingNameOrId.toLowerCase() || 
            (b.id && b.id.toLowerCase() === bindingNameOrId.toLowerCase())
        );

        if (found) {
            return { binding: found, targetModel: targetModel || defaultModel };
        }
        return { binding: fallbackBinding, targetModel: targetModel || defaultModel };
    }

    // 2. Lookup in cached model-to-binding registry
    if (this._modelToBindingMap.has(raw)) {
        const entry = this._modelToBindingMap.get(raw)!;
        const target = entry.targetModel || entry.rawModel || raw || defaultModel;
        return { binding: entry.binding, targetModel: target };
    }
    if (this._rawModelToBindingMap.has(raw)) {
        const entry = this._rawModelToBindingMap.get(raw)!;
        const target = entry.targetModel || entry.rawModel || raw || defaultModel;
        return { binding: entry.binding, targetModel: target };
    }

    return { binding: fallbackBinding, targetModel: raw || defaultModel };
  }

  public getModelName(): string {
      return this.config.modelName;
  }

  /**
   * Fast connection probe to detect offline server before initiating long generation passes.
   * Tolerates slow local model warm-ups and automatically falls back to 127.0.0.1 if localhost stalls.
   */
  public async pingServer(timeoutMs: number = 5000, model?: string): Promise<{ online: boolean; error?: string }> {
      const resolved = this.resolveBindingForModel(model);
      const targetBinding = resolved.binding;
      const baseUrl = this.normalizeBaseUrl(targetBinding.apiUrl);

      const tryProbe = async (urlStr: string, ms: number) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ms);
          try {
              const testUrl = targetBinding.backendType === 'ollama' 
                  ? `${urlStr}/api/tags`
                  : `${urlStr}/v1/models`;

              const agent = this.getAgentForBinding(targetBinding);
              const headers: Record<string, string> = {};
              if (targetBinding.apiKey) {
                  headers['Authorization'] = `Bearer ${targetBinding.apiKey}`;
              }

              const response = await fetch(testUrl, {
                  method: 'GET',
                  headers,
                  signal: controller.signal,
                  agent
              });

              // Any response from the HTTP listener (even 401/404) proves the server is online
              return { online: true, status: response.status };
          } catch (err: any) {
              return { online: false, error: err };
          } finally {
              clearTimeout(timer);
          }
      };

      // 1. Try with the primary configured URL
      let probe = await tryProbe(baseUrl, timeoutMs);
      if (probe.online) return { online: true };

      // 2. IPv4 fallback: If baseUrl uses 'localhost', try '127.0.0.1' (bypasses Node 18+ Windows IPv6 ::1 stalls)
      if (baseUrl.includes('localhost')) {
          const ipv4Url = baseUrl.replace('localhost', '127.0.0.1');
          const ipv4Probe = await tryProbe(ipv4Url, timeoutMs);
          if (ipv4Probe.online) {
              return { online: true };
          }
      }

      const err = probe.error;
      const isTimeout = err?.name === 'AbortError' || err?.message?.includes('timeout');

      // If it merely timed out, the server may be under local load or loading model weights.
      // Do NOT block the user turn on a timeout; let sendChat proceed with the real connection stream.
      if (isTimeout) {
          Logger.warn(`[pingServer] Probe reached ${timeoutMs}ms limit without refusal. Allowing request to proceed directly to sendChat.`);
          return { online: true };
      }

      const msg = err?.code === 'ECONNREFUSED' 
          ? 'Connection refused (ECONNREFUSED)' 
          : (err?.message || 'Server is not responding');

      return { online: false, error: msg };
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

  private async fetchModelsForBinding(binding: ServerBinding): Promise<Array<{ id: string }>> {
    const backend = binding.backendType;

    if (backend === 'anthropic') {
        return [
            { id: 'claude-3-7-sonnet-latest' },
            { id: 'claude-3-5-sonnet-latest' },
            { id: 'claude-3-opus-latest' },
            { id: 'claude-3-haiku-20240307' }
        ];
    }

    let url = this.normalizeBaseUrl(binding.apiUrl);
    let headers: any = {};
    if (binding.apiKey) {
        headers['Authorization'] = `Bearer ${binding.apiKey}`;
    }

    if (backend === 'ollama') {
        url = url.endsWith('/api/tags') ? url : (url.endsWith('/api') ? `${url}/tags` : `${url}/api/tags`);
    } else if (backend === 'openwebui') {
        url = url.endsWith('/models') ? url : `${url}/models`;
    } else if (backend === 'google') {
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${binding.apiKey || ''}`;
        headers = {};
    } else {
        const pathLower = url.toLowerCase();
        if (pathLower.endsWith('/v1') || pathLower.endsWith('/v1/')) {
            url = url.replace(/\/+$/, '') + '/models';
        } else {
            url = url.replace(/\/+$/, '') + '/v1/models';
        }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
        const agent = this.getAgentForBinding(binding);
        const response = await fetch(url, {
            method: 'GET',
            headers,
            signal: controller.signal,
            agent
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

        return rawList.map((m: any) => {
            if (typeof m === 'string') return { id: m };
            return { id: m.id || m.name || m.model || String(m) };
        }).filter(m => m.id);

    } finally {
        clearTimeout(timeout);
    }
  }

  public async getModels(forceRefresh: boolean = false): Promise<Array<{ id: string; name?: string; server?: string }>> {
    Logger.info(`[getModels] Cumulative query called across all active server bindings. Force: ${forceRefresh}`);

    if (forceRefresh) {
        this._cachedModels = null;
        this._modelToBindingMap.clear();
        this._rawModelToBindingMap.clear();
        if (this.globalState) {
            this.globalState.update('lollms_models_cache', undefined);
        }
    } else {
        if (this._cachedModels && this._cachedModels.length > 0) {
            return this._cachedModels;
        }

        if (this.globalState) {
            const storedModels = this.globalState.get<Array<{ id: string; name?: string; server?: string }>>('lollms_models_cache');
            if (storedModels && storedModels.length > 0) {
                this._cachedModels = storedModels;
                return storedModels;
            }
        }
    }

    const activeBindings = this.getAllActiveBindings();
    if (activeBindings.length === 0) {
        return [];
    }

    const results = await Promise.allSettled(
        activeBindings.map(async (binding) => {
            try {
                const models = await this.fetchModelsForBinding(binding);
                return { binding, models };
            } catch (err: any) {
                Logger.warn(`[getModels] Failed to query binding '${binding.name}' (${binding.apiUrl}): ${err.message}`);
                return { binding, models: [] };
            }
        })
    );

    const aggregated: Array<{ id: string; name: string; server: string }> = [];
    const isMultiServer = activeBindings.length > 1;

    for (const res of results) {
        if (res.status === 'fulfilled') {
            const { binding, models } = res.value;
            for (const m of models) {
                const compositeId = isMultiServer ? `${binding.name}::${m.id}` : m.id;
                const displayName = isMultiServer ? `[${binding.name}] ${m.id}` : m.id;

                aggregated.push({
                    id: compositeId,
                    name: displayName,
                    server: binding.name
                });

                const routeInfo = { binding, targetModel: m.id, rawModel: m.id };
                this._modelToBindingMap.set(compositeId, routeInfo);

                // Register unnamespaced fallback if not already claimed by an earlier binding
                if (!this._rawModelToBindingMap.has(m.id)) {
                    this._rawModelToBindingMap.set(m.id, routeInfo);
                }
            }
        }
    }

    this._cachedModels = aggregated;
    if (this.globalState) {
        this.globalState.update('lollms_models_cache', aggregated);
    }
    return aggregated;
  }

  public async tokenize(text: string, model?: string): Promise<TokenizeResponse> {
    const resolved = this.resolveBindingForModel(model);
    const targetBinding = resolved.binding;
    const modelName = resolved.targetModel;
    const backend = targetBinding.backendType;
    const safeText = text || "";

    if (!modelName || backend !== 'lollms' || targetBinding.useLollmsExtensions === false) {
        const hasCode = safeText.includes('{') || safeText.includes('def ') || safeText.includes('function ') || safeText.includes('import ');
        const multiplier = hasCode ? 0.35 : 0.28;
        return { count: Math.ceil(safeText.length * multiplier), tokens: [], isEstimation: true };
    }

    const tokenizeUrl = `${this.normalizeBaseUrl(targetBinding.apiUrl)}/lollms/v1/tokenize`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (targetBinding.apiKey) {
            headers['Authorization'] = `Bearer ${targetBinding.apiKey}`;
        }

        const agent = this.getAgentForBinding(targetBinding);
        const response = await fetch(tokenizeUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: modelName, text: safeText }),
            signal: controller.signal,
            agent
        });

        if (response.ok) {
            const data = await response.json() as TokenizeResponse;
            return { ...data, isEstimation: false };
        }
    } catch {
        // Fallback to high-speed local tokenizer
    } finally {
        clearTimeout(timeout);
    }

    return this.tokenizeLocal(safeText);
  }

    /**
    * High-speed code-aware heuristic tokenizer.
    * Runs locally with zero latency when the server is unreachable.
    */
    private tokenizeLocal(text: string): TokenizeResponse {
    if (!text) return { count: 0, tokens: [], isEstimation: true };

    // 1. Split by whitespace and common code symbols
    // This captures tokens more accurately than raw character division
    const words = text.split(/(\s+|[{}()\[\].,;+\-*/%&|^!<>?:=@#$])/);

    let tokenCount = 0;
    for (const word of words) {
        if (!word) continue;

        // Whitespace: usually 1 token per block of 4 spaces or single newline
        if (/^\s+$/.test(word)) {
            tokenCount += Math.max(1, Math.ceil(word.length / 4));
            continue;
        }

        // Long words (likely base64 or long variable names): approx 4 chars per token
        if (word.length > 4) {
            tokenCount += Math.ceil(word.length / 4);
        } else {
            // Symbols and short words: usually 1 token
            tokenCount += 1;
        }
    }

    // Safety margin for BPE overhead
    const count = Math.ceil(tokenCount * 1.1);

    return { 
        count, 
        tokens: [], 
        isEstimation: true 
    };
    }

  public async getContextSize(model?: string): Promise<ContextSizeResponse> {
    const resolved = this.resolveBindingForModel(model);
    const targetBinding = resolved.binding;
    const modelName = resolved.targetModel || (model || "").trim();

    if (this._cachedContextSizes.has(modelName)) {
        const cachedSize = this._cachedContextSizes.get(modelName)!;
        return { context_size: cachedSize, isEstimation: false };
    }

    const useExtensions = targetBinding.useLollmsExtensions !== false && targetBinding.backendType === 'lollms';
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const manualOverride = config.get<number>('failsafeContextSize') || 0;

    if (!useExtensions || !modelName) {
        let heuristic = 128000;
        try {
            const { getContextLimitForModel } = require('./utils');
            heuristic = getContextLimitForModel(modelName);
        } catch {}

        return { 
            context_size: manualOverride || heuristic || 128000, 
            isEstimation: manualOverride === 0, 
            isUserDefined: manualOverride > 0 
        };
    }

    const contextSizeUrl = `${this.normalizeBaseUrl(targetBinding.apiUrl)}/lollms/v1/context_size`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (targetBinding.apiKey) headers['Authorization'] = `Bearer ${targetBinding.apiKey}`;

        const agent = this.getAgentForBinding(targetBinding);
        const response = await fetch(contextSizeUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: modelName }),
            signal: controller.signal,
            agent
        });

        if (response.ok) {
            const data = await response.json() as ContextSizeResponse;
            if (data && typeof data.context_size === 'number' && data.context_size > 0) {
                this._cachedContextSizes.set(modelName, data.context_size);
                return { ...data, isEstimation: false };
            }
        }
    } catch {
        // Recover with local heuristic
    } finally {
        clearTimeout(timeout);
    }

    let heuristicSize = 128000;
    try {
        const { getContextLimitForModel } = require('./utils');
        heuristicSize = getContextLimitForModel(modelName);
    } catch {}

    const finalSize = Math.max(manualOverride || 0, heuristicSize || 0, 128000);
    return { 
        context_size: finalSize, 
        isEstimation: true, 
        isUserDefined: manualOverride > 0
    };
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
        agent: isHttps && extractUrl.startsWith(this.baseUrl) ? this.httpsAgent : undefined
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

    const response = await fetch(extractUrl, { 
        ...options, 
        agent: isHttps && extractUrl.startsWith(this.baseUrl) ? this.httpsAgent : undefined 
    });
    if (!response.ok) throw new Error(`Failed to extract text: ${response.status}`);
    const data = await response.json();
    return data.text || '';
  }


  /**
   * Generates a new image based on a prompt.
   * Matches the ImageGenerationRequest (JSON) backend model.
   */
  public async generateImage(prompt: string, options?: { size?: string, quality?: 'standard' | 'hd' }, token?: vscode.CancellationToken): Promise<string> {
    if (!this.baseUrl) throw new Error("Lollms API URL is not configured correctly.");

    const imageUrl = `${this.baseUrl}/v1/images/generations`;
    const isHttps = imageUrl.startsWith('https');

    const requestBody: ImageGenerationRequest = {
        prompt: prompt,
        n: 1,
        response_format: 'b64_json',
        size: options?.size || "1024x1024",
        quality: options?.quality || "standard"
    };

    // Only send model if explicitly set, otherwise let the backend (Lollms) autoselect
    if (this.config.ttiModelName) {
        requestBody.model = this.config.ttiModelName;
    }

    const controller = new AbortController();
    if (token) token.onCancellationRequested(() => controller.abort());

    try {
        const response = await fetch(imageUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.config.apiKey}`
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
            agent: isHttps && imageUrl.startsWith(this.baseUrl) ? this.httpsAgent : undefined
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Image Generation Error: ${response.status} - ${errorBody}`);
        }

        const data: ImageGenerationResponse = await response.json();

        if (data.data && data.data[0]) {
            const img = data.data[0];
            return img.b64_json || img.url || "";
        }
        throw new Error('API response did not contain valid image data.');

    } catch (error: any) {
        if (error.name === 'AbortError') throw new Error("Image generation cancelled.");
        throw error;
    }
  }

  /**
   * Edits or Blends images.
   * Matches create_image_edit (Multipart/Form-Data) backend endpoint.
   */
  public async editImage(
    prompt: string, 
    imagesBase64: string[], 
    maskBase64?: string, 
    model?: string, 
    token?: vscode.CancellationToken,
    width: number = 1024,
    height: number = 1024
  ): Promise<string> {
    if (!this.baseUrl) throw new Error("Lollms API URL is not configured correctly.");

    const url = `${this.baseUrl}/v1/images/edits`;
    const isHttps = url.startsWith('https');

    const dataUriToBuffer = (uri: string) => {
        const base64Data = uri.includes(',') ? uri.split(',')[1] : uri;
        return Buffer.from(base64Data, 'base64');
    };

    const formData = new FormData();
    
    // 1. Mandatory Form Fields (sent as part of multipart body)
    formData.append('prompt', prompt);
    formData.append('response_format', 'b64_json');
    formData.append('n', '1');
    
    const finalModel = model || this.config.ttiModelName;
    if (finalModel) {
        formData.append('model', finalModel);
    }

    // 1.5 Add dimensions if provided
    if (width) formData.append('width', width.toString());
    if (height) formData.append('height', height.toString());

    // 2. Append multiple 'image' files to support blending/multi-source
    imagesBase64.forEach((uri, idx) => {
        const buffer = dataUriToBuffer(uri);
        formData.append('image', buffer, {
            filename: `input_image_${idx}.png`,
            contentType: 'image/png'
        });
    });

    if (maskBase64) {
        const maskBuffer = dataUriToBuffer(maskBase64);
        formData.append('mask', maskBuffer, {
            filename: 'mask.png',
            contentType: 'image/png'
        });
    }

    const controller = new AbortController();
    if (token) token.onCancellationRequested(() => controller.abort());

    try {
        // Resolve form data into a buffer to correctly set Content-Length
        const body = formData.getBuffer();
        
        const headers = {
            ...formData.getHeaders(),
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Length': body.length.toString()
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: body,
            signal: controller.signal,
            agent: isHttps && url.startsWith(this.baseUrl) ? this.httpsAgent : undefined
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Image Edit Error ${response.status}: ${errBody}`);
        }

        const data = await response.json() as ImageGenerationResponse;

        if (data.data && data.data[0]) {
            const result = data.data[0];
            return result.b64_json || result.url || "";
        }
            
        throw new Error('API did not return recognizable image data.');
    } catch (error: any) {
        if (error.name === 'AbortError') throw new Error("Image edit timed out or was cancelled.");
        throw error;
    }
  }
  
  async sendChat(
    messages: ChatMessage[],
    onChunk?: ((chunk: string) => void) | null,
    signal?: AbortSignal,
    modelOverride?: string,
    options?: { thinking?: boolean, capabilities?: any, temperature?: number, maxTokens?: number, max_tokens?: number, reasoningEffort?: 'none' | 'low' | 'medium' | 'high' }
  ): Promise<string> {
    const resolved = this.resolveBindingForModel(modelOverride);
    const targetBinding = resolved.binding;
    const model = resolved.targetModel || modelOverride || this.config.modelName || "default";
    const backend = targetBinding.backendType;
    const stream = !!onChunk;

    let url = this.normalizeBaseUrl(targetBinding.apiUrl);
    let headers: any = { 
        'Content-Type': 'application/json'
    };
    if (targetBinding.apiKey) {
        headers['Authorization'] = `Bearer ${targetBinding.apiKey}`;
    }
    let body: any = {};

    const vsConfig = vscode.workspace.getConfiguration('lollmsVsCoder');
    const { isModelVisionCapable } = require('./utils');
    const autoSuppress = vsConfig.get<boolean>('autoSuppressImagesForNonVisionModels', true);
    const visionSupported = options?.capabilities?.enableImages !== false && 
        (!autoSuppress || isModelVisionCapable(model, vsConfig));

    const { ensureStrictAlternatingRoles } = require('./utils');
    const normalizedMessages = ensureStrictAlternatingRoles(messages.filter(m => !m.skipInPrompt));

    const sanitizedMessages = normalizedMessages.map((m: any) => {
        let content = m.content;

        // Strip thinking blocks from assistant messages so prior reasoning does not pollute prompt
        if (m.role === 'assistant') {
            if (typeof content === 'string') {
                content = stripThinkingTags(content).trim();
            } else if (Array.isArray(content)) {
                content = content.map((part: any) => {
                    if (part && part.type === 'text' && typeof part.text === 'string') {
                        return { ...part, text: stripThinkingTags(part.text).trim() };
                    }
                    return part;
                });
            }
        }

        // --- MULTIMODAL FORMATTING GUARD ---
        if (Array.isArray(content)) {
            if (!visionSupported) {
                // Strip image_url from outbound payload for text-only models
                const textParts = content.filter(part => part.type === 'text').map(part => part.text);
                const hasMutedImages = content.some(part => part.type === 'image_url');
                let combined = textParts.join('\n');
                if (hasMutedImages) {
                    combined += (combined ? '\n' : '') + `[Attached image omitted: ${model} is a text-only model]`;
                }
                content = combined || '[Image suppressed]';
            } else {
                content = content.map(part => {
                    if (part.type === 'image_url' && part.image_url?.url) {
                        let url = part.image_url.url;
                        if (!url.startsWith('data:') && !url.startsWith('http')) {
                            url = `data:image/png;base64,${url}`;
                        }
                        return { ...part, image_url: { ...part.image_url, url } };
                    }
                    return part;
                });
            }
        }

        return {
            role: m.role === 'system' && (backend === 'anthropic' || backend === 'google') ? 'user' : m.role,
            content: content
        };
    });

    // 🛡️ DEFENSIVE PAYLOAD NORMALIZATION: Ensure at least one 'user' message exists across all backends
    if (!sanitizedMessages.some(m => m.role === 'user')) {
        sanitizedMessages.push({
            role: 'user',
            content: 'Please proceed and generate the response based on the system instructions provided.'
        });
    }

    // =========================================================================
    // 🛡️ FINAL API OUTBOUND LOG (DEBUG)
    // =========================================================================
    
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

    // Resolve timeout values from capabilities or global config with extended default limit (180s)
    // 0 = Infinity (no timer started)
    const globalTimeout = vsConfig.get<number>('requestTimeout') || 180000;
    const ttftTimeoutValue = options?.capabilities?.ttftTimeout ?? globalTimeout;
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
    const isThinkingActive = options?.thinking !== undefined ? options.thinking : (vsConfig.get<boolean>('thinkingMode') || false);

    const reasoningEffort = options?.reasoningEffort || options?.capabilities?.reasoningEffort || vsConfig.get<string>('reasoningEffort') || 'low';
    const thinkingBudget = options?.capabilities?.thinkingBudget || vsConfig.get<number>('thinkingBudget') || 16000;
    const reqMaxTokens = options?.maxTokens ?? options?.max_tokens;

    if (backend === 'ollama') {
        url = url.endsWith('/api/chat') ? url : `${url}/api/chat`;
        body = { 
            model, 
            messages: sanitizedMessages, 
            stream
        };
        const ollamaOpts: any = {};
        if (options?.temperature !== undefined) {
            ollamaOpts.temperature = options.temperature;
        }
        if (reqMaxTokens !== undefined && reqMaxTokens > 0) {
            ollamaOpts.num_predict = reqMaxTokens;
        }
        if (Object.keys(ollamaOpts).length > 0) {
            body.options = ollamaOpts;
        }
        // Only inject the 'think' key if explicitly requested to avoid 500 on standard models
        if (reasoningEffort === 'none') {
            body.think = false;
        } else if (isThinkingActive) {
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
            stream,
            max_tokens: reqMaxTokens && reqMaxTokens > 0 ? reqMaxTokens : 4096
        };
        if (options?.temperature !== undefined) {
            body.temperature = options.temperature;
        }
        if (isThinkingActive && reasoningEffort !== 'none') {
            const dynamicBudget = reasoningEffort === 'low' ? 4096 : (reasoningEffort === 'high' ? 32000 : 16000);
            body.thinking = { type: "enabled", budget_tokens: dynamicBudget };
        }
    } else if (backend === 'openai' || backend === 'lollms') {
        const pathLower = url.toLowerCase();
        if (pathLower.endsWith('/v1') || pathLower.endsWith('/v1/')) {
            url = url.replace(/\/+$/, '') + '/chat/completions';
        } else {
            url = url.replace(/\/+$/, '') + '/v1/chat/completions';
        }
        body = { 
            model, 
            messages: sanitizedMessages, 
            stream
        };
        if (options?.temperature !== undefined) {
            body.temperature = options.temperature;
        }
        if (reqMaxTokens !== undefined && reqMaxTokens > 0) {
            body.max_tokens = reqMaxTokens;
        }
        if (reasoningEffort === 'none') {
            body.reasoning_effort = 'none';
        } else if (isThinkingActive) {
            body.reasoning_effort = reasoningEffort;
            if (reqMaxTokens !== undefined && reqMaxTokens > 0) {
                body.max_completion_tokens = reqMaxTokens;
            }
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
        const genConfig: any = {};
        if (options?.temperature !== undefined) {
            genConfig.temperature = options.temperature;
        }
        if (reqMaxTokens !== undefined && reqMaxTokens > 0) {
            genConfig.maxOutputTokens = reqMaxTokens;
        }
        if (Object.keys(genConfig).length > 0) {
            body.generationConfig = genConfig;
        }

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
        if (options?.temperature !== undefined) body.temperature = options.temperature;
        if (reqMaxTokens !== undefined && reqMaxTokens > 0) body.max_tokens = reqMaxTokens;
    } else if (backend === 'openwebui') {
        // OpenWebUI serves OpenAI API at /api/chat/completions
        // We assume the user provides the base URL ending in /api
        url += '/chat/completions';
        body = { model, messages: sanitizedMessages, stream };
        if (options?.temperature !== undefined) body.temperature = options.temperature;
        if (reqMaxTokens !== undefined && reqMaxTokens > 0) body.max_tokens = reqMaxTokens;
    } else {
        url += '/v1/chat/completions';
        body = { model, messages: sanitizedMessages, stream };
        if (options?.temperature !== undefined) body.temperature = options.temperature;
        if (reqMaxTokens !== undefined && reqMaxTokens > 0) body.max_tokens = reqMaxTokens;
    }



    try {
        const agent = this.getAgentForBinding(targetBinding);

        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
                agent
            });
        } catch (fetchErr: any) {
            // IPv4 fallback for localhost when Node.js on Windows tries IPv6 ::1 first
            if (url.includes('localhost') && (fetchErr.code === 'ECONNREFUSED' || fetchErr.name === 'AbortError' || fetchErr.code === 'ETIMEDOUT')) {
                const ipv4Url = url.replace('localhost', '127.0.0.1');
                Logger.info(`[sendChat] Connection to localhost failed (${fetchErr.message}). Retrying with 127.0.0.1: ${ipv4Url}`);
                response = await fetch(ipv4Url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: controller.signal,
                    agent
                });
            } else if (fetchErr.message?.includes('disposed')) {
                throw new Error("Local VS Code extension host is unstable. Please reload window.");
            } else {
                throw fetchErr;
            }
        }

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
                            content = data.message?.content || 
                                     data.message?.thinking || 
                                     data.response || 
                                     '';
                        } else if (backend === 'anthropic') {
                            if (trimmed.startsWith('data: ')) {
                                const data = JSON.parse(trimmed.substring(6));
                                if (data.type === 'content_block_delta') {
                                    content = data.delta?.text || 
                                             data.delta?.thinking || 
                                             '';
                                }
                            }
                        } else if (backend === 'google') {
                            const data = JSON.parse(trimmed.startsWith('[') ? trimmed.substring(1) : trimmed);
                            content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                        } else {
                            if (trimmed.startsWith('data: ')) {
                                const raw = trimmed.substring(6).trim();
                                if (raw === '[DONE]') continue;
                                const data = JSON.parse(raw);
                                const delta = data.choices?.[0]?.delta;
                                if (delta) {
                                    if (delta.content !== undefined && delta.content !== null) {
                                        content = delta.content;
                                    } else if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
                                        content = delta.reasoning_content;
                                    } else if (delta.reasoning !== undefined && delta.reasoning !== null) {
                                        content = delta.reasoning;
                                    } else if (delta.thought !== undefined && delta.thought !== null) {
                                        content = delta.thought;
                                    }
                                } else if (data.choices?.[0]?.text) {
                                    content = data.choices[0].text;
                                }
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

            // Record transaction to billing database asynchronously
            try {
                const { TokenBillingManager } = require('./utils/tokenBillingManager');
                const rawPrompt = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
                const estimatedInput = Math.ceil(rawPrompt.length / 3.5);
                const estimatedOutput = Math.ceil(fullResponse.length / 3.5);
                TokenBillingManager.logTransaction(model, estimatedInput, estimatedOutput, 'chat_stream');
            } catch (billingErr) {
                console.warn("Failed to record billing entry:", billingErr);
            }

            return fullResponse;
        } else {
            const data = await response.json();
            let resultText = "";
            if (backend === 'ollama') {
                resultText = data.message?.content || data.message?.thinking || data.response || '';
            } else if (backend === 'anthropic') {
                resultText = data.content?.[0]?.text || data.content?.[0]?.thinking || '';
            } else if (backend === 'google') {
                resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            } else {
                const choice = data.choices?.[0];
                resultText = choice?.message?.content || 
                             choice?.message?.reasoning_content || 
                             choice?.message?.reasoning || 
                             choice?.message?.thought || 
                             choice?.text || 
                             '';
            }

            // Record transaction to billing database
            try {
                const { TokenBillingManager } = require('./utils/tokenBillingManager');
                const rawPrompt = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
                const estimatedInput = Math.ceil(rawPrompt.length / 3.5);
                const estimatedOutput = Math.ceil(resultText.length / 3.5);
                TokenBillingManager.logTransaction(model, estimatedInput, estimatedOutput, 'chat_unary');
            } catch (billingErr) {}

            return resultText;
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
