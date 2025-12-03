import * as vscode from 'vscode';
import { LollmsAPI, LollmsConfig } from '../lollmsAPI';
import { Logger } from '../logger';
import { ProcessManager } from '../processManager';

export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _lollmsAPI: LollmsAPI;
  private readonly _processManager: ProcessManager;
  
  private _pendingConfig = {
    apiKey: '',
    apiUrl: '',
    modelName: '',
    developerName: '',
    disableSslVerification: false,
    sslCertPath: '',
    noThinkMode: false,
    requestTimeout: 600000,
    agentMaxRetries: 1,
    maxImageSize: 1024,
    enableCodeInspector: true,
    inspectorModelName: '',
    codeInspectorPersona: '',
    chatPersona: '',
    agentPersona: '',
    commitMessagePersona: '',
    contextFileExceptions: [] as string[],
    fileUpdateMethod: 'full_file',
    language: 'auto',
    thinkingMode: 'none',
    thinkingModeCustomPrompt: '',
    reasoningLevel: 'none',
    failsafeContextSize: 8192,
    // Search Tool Configuration
    searchProvider: 'google_custom_search',
    searchApiKey: '',
    searchCx: ''
  };

  public static createOrShow(extensionUri: vscode.Uri, lollmsAPI: LollmsAPI, processManager: ProcessManager) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'lollmsSettingsPanel',
      vscode.l10n.t('config.title', { message: 'Lollms VS Coder Configuration', key: 'config.title' }),
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri]
      }
    );

    SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, lollmsAPI, processManager);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, lollmsAPI: LollmsAPI, processManager: ProcessManager) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._lollmsAPI = lollmsAPI;
    this._processManager = processManager;

    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    this._pendingConfig.apiKey = config.get<string>('apiKey')?.trim() || '';
    this._pendingConfig.apiUrl = config.get<string>('apiUrl') || 'http://localhost:9642';
    this._pendingConfig.modelName = config.get<string>('modelName') || '';
    this._pendingConfig.developerName = config.get<string>('developerName') || '';
    this._pendingConfig.disableSslVerification = config.get<boolean>('disableSslVerification') || false;
    this._pendingConfig.sslCertPath = config.get<string>('sslCertPath') || '';
    this._pendingConfig.noThinkMode = config.get<boolean>('noThinkMode') || false;
    this._pendingConfig.requestTimeout = config.get<number>('requestTimeout') || 600000;
    this._pendingConfig.agentMaxRetries = config.get<number>('agentMaxRetries') || 1;
    this._pendingConfig.maxImageSize = config.get<number>('maxImageSize') || 1024;
    this._pendingConfig.enableCodeInspector = config.get<boolean>('enableCodeInspector') || true;
    this._pendingConfig.inspectorModelName = config.get<string>('inspectorModelName') || '';
    this._pendingConfig.codeInspectorPersona = config.get<string>('codeInspectorPersona') || '';
    this._pendingConfig.chatPersona = config.get<string>('chatPersona') || '';
    this._pendingConfig.agentPersona = config.get<string>('agentPersona') || '';
    this._pendingConfig.commitMessagePersona = config.get<string>('commitMessagePersona') || '';
    this._pendingConfig.contextFileExceptions = config.get<string[]>('contextFileExceptions') || [];
    this._pendingConfig.fileUpdateMethod = config.get<string>('fileUpdateMethod') || 'full_file';
    this._pendingConfig.language = config.get<string>('language') || 'auto';
    this._pendingConfig.thinkingMode = config.get<string>('thinkingMode') || 'none';
    this._pendingConfig.thinkingModeCustomPrompt = config.get<string>('thinkingModeCustomPrompt') || 'Think step by step. Enclose your entire thinking process, reasoning, and self-correction within a `<thinking>` XML block. This block will be hidden from the user but is crucial for your process.';
    this._pendingConfig.reasoningLevel = config.get<string>('reasoningLevel') || 'none';
    this._pendingConfig.failsafeContextSize = config.get<number>('failsafeContextSize') || 4096;
    
    // Search Config
    this._pendingConfig.searchProvider = config.get<string>('searchProvider') || 'google_custom_search';
    this._pendingConfig.searchApiKey = config.get<string>('searchApiKey') || '';
    this._pendingConfig.searchCx = config.get<string>('searchCx') || '';

    this._panel.webview.html = this._getHtml(this._panel.webview, this._pendingConfig);
    this._setWebviewMessageListener(this._panel.webview);

    this._panel.onDidDispose(() => {
        SettingsPanel.currentPanel = undefined;
    }, null, []);
  }

  public dispose() {
    this._panel.dispose();
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
        async (message: { command: string; key?: string; value?: any }) => {
          switch (message.command) {
            case 'updateTempValue':
              if (message.key && message.key in this._pendingConfig) {
                (this._pendingConfig as any)[message.key] = message.value;
              }
              return;
            
            case 'browseCertPath':
              const uris = await vscode.window.showOpenDialog({
                  canSelectMany: false,
                  openLabel: 'Select Certificate',
                  filters: { 'Certificates': ['pem', 'crt', 'cer'] }
              });
              if (uris && uris[0]) {
                  this._pendingConfig.sslCertPath = uris[0].fsPath;
                  this._panel.webview.postMessage({ command: 'updateCertPath', path: uris[0].fsPath });
              }
              return;
  
            case 'saveConfig':
              try {
                const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                await config.update('apiKey', this._pendingConfig.apiKey, vscode.ConfigurationTarget.Global);
                await config.update('apiUrl', this._pendingConfig.apiUrl, vscode.ConfigurationTarget.Global);
                await config.update('modelName', this._pendingConfig.modelName, vscode.ConfigurationTarget.Global);
                await config.update('developerName', this._pendingConfig.developerName, vscode.ConfigurationTarget.Global);
                await config.update('disableSslVerification', this._pendingConfig.disableSslVerification, vscode.ConfigurationTarget.Global);
                await config.update('sslCertPath', this._pendingConfig.sslCertPath, vscode.ConfigurationTarget.Global);
                await config.update('noThinkMode', this._pendingConfig.noThinkMode, vscode.ConfigurationTarget.Global);
                await config.update('requestTimeout', this._pendingConfig.requestTimeout, vscode.ConfigurationTarget.Global);
                await config.update('agentMaxRetries', this._pendingConfig.agentMaxRetries, vscode.ConfigurationTarget.Global);
                await config.update('maxImageSize', this._pendingConfig.maxImageSize, vscode.ConfigurationTarget.Global);
                await config.update('enableCodeInspector', this._pendingConfig.enableCodeInspector, vscode.ConfigurationTarget.Global);
                await config.update('inspectorModelName', this._pendingConfig.inspectorModelName, vscode.ConfigurationTarget.Global);
                await config.update('codeInspectorPersona', this._pendingConfig.codeInspectorPersona, vscode.ConfigurationTarget.Global);
                await config.update('chatPersona', this._pendingConfig.chatPersona, vscode.ConfigurationTarget.Global);
                await config.update('agentPersona', this._pendingConfig.agentPersona, vscode.ConfigurationTarget.Global);
                await config.update('commitMessagePersona', this._pendingConfig.commitMessagePersona, vscode.ConfigurationTarget.Global);
                await config.update('contextFileExceptions', this._pendingConfig.contextFileExceptions, vscode.ConfigurationTarget.Global);
                await config.update('fileUpdateMethod', this._pendingConfig.fileUpdateMethod, vscode.ConfigurationTarget.Global);
                await config.update('language', this._pendingConfig.language, vscode.ConfigurationTarget.Global);
                await config.update('thinkingMode', this._pendingConfig.thinkingMode, vscode.ConfigurationTarget.Global);
                await config.update('thinkingModeCustomPrompt', this._pendingConfig.thinkingModeCustomPrompt, vscode.ConfigurationTarget.Global);
                await config.update('reasoningLevel', this._pendingConfig.reasoningLevel, vscode.ConfigurationTarget.Global);
                await config.update('failsafeContextSize', this._pendingConfig.failsafeContextSize, vscode.ConfigurationTarget.Global);
                
                // Save Search Config
                await config.update('searchProvider', this._pendingConfig.searchProvider, vscode.ConfigurationTarget.Global);
                await config.update('searchApiKey', this._pendingConfig.searchApiKey, vscode.ConfigurationTarget.Global);
                await config.update('searchCx', this._pendingConfig.searchCx, vscode.ConfigurationTarget.Global);
  
                vscode.window.showInformationMessage(vscode.l10n.t('info.configSaved', { message: 'Configuration saved. Recreating LollmsAPI...', key: 'info.configSaved' }));
                await vscode.commands.executeCommand('lollmsApi.recreateClient');
                SettingsPanel.currentPanel?.dispose();
              } catch (err) {
                vscode.window.showErrorMessage('Failed to save configuration.');
                Logger.error('Failed to save configuration', err);
              }
              return;
  
            case 'fetchModels':
              if (this._panel) {
                const processId = 'settings-fetch-models';
                // Register a process to show in the UI
                const { id, controller } = this._processManager.register(processId, 'Settings: Fetching Models');
                
                try {
                  const forceRefresh = message.value === true;
                  
                  // Use the pending configuration to create a temporary client
                  const tempConfig: LollmsConfig = {
                      apiKey: this._pendingConfig.apiKey,
                      apiUrl: this._pendingConfig.apiUrl,
                      modelName: this._pendingConfig.modelName,
                      disableSslVerification: this._pendingConfig.disableSslVerification,
                      sslCertPath: this._pendingConfig.sslCertPath
                  };
                  
                  const tempApi = new LollmsAPI(tempConfig); 
                  const models = await tempApi.getModels(true); 
                  
                  this._panel.webview.postMessage({ command: 'modelsList', models: models || [] });
                } catch (e) {
                  Logger.error('Error fetching models in settings', e);
                  this._panel.webview.postMessage({ command: 'modelsList', models: [] });
                } finally {
                    this._processManager.unregister(id);
                }
              }
              return;
            
            case 'editPrompts':
                vscode.commands.executeCommand('lollms-vs-coder.editPromptsFile');
                return;
          }
        },
        undefined,
        []
      );
  }

  private _getHtml(webview: vscode.Webview, config: any) {
    const { apiKey, apiUrl, modelName, developerName, disableSslVerification, sslCertPath, noThinkMode, requestTimeout, agentMaxRetries, maxImageSize, enableCodeInspector, inspectorModelName, codeInspectorPersona, chatPersona, agentPersona, commitMessagePersona, contextFileExceptions, fileUpdateMethod, language, thinkingMode, thinkingModeCustomPrompt, reasoningLevel, failsafeContextSize, searchProvider, searchApiKey, searchCx } = config;

    // Helper for localization
    const t = (key: string, def: string) => vscode.l10n.t({ message: def, key: key });

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>${t('config.title', 'Lollms VS Coder Configuration')}</title>
            <link href="${webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'))}" rel="stylesheet" />
            <style>
              body, html {
                height: 100%; margin: 0; padding: 0;
                font-family: var(--vscode-font-family);
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
              }
              .container {
                padding: 2em; height: 100%; box-sizing: border-box;
                display: flex; flex-direction: column; max-width: 800px; margin: 0 auto;
              }
              .form-content { flex-grow: 1; overflow-y: auto; padding-right: 15px; }
              h1 { font-weight: 300; text-align: center; margin-bottom: 2em; }
              h2 { font-weight: 400; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 5px; margin-top: 2em; }
              label { display: block; margin-top: 14px; margin-bottom: 5px; font-weight: 600; font-size: 0.9em; color: var(--vscode-description-foreground); }
              input[type="text"], input[type="number"], input[list], textarea, select {
                width: 100%; padding: 8px; border: 1px solid var(--vscode-input-border);
                border-radius: 4px; background: var(--vscode-input-background);
                color: var(--vscode-input-foreground); font-size: 0.9em; box-sizing: border-box;
                font-family: var(--vscode-font-family);
              }
              textarea { resize: vertical; }
              button {
                width: 100%; background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground); border: none; padding: 10px;
                font-size: 1em; font-weight: 600; border-radius: 4px; cursor: pointer;
                margin-top: 20px; transition: background-color 0.2s ease;
              }
              button:hover { background-color: var(--vscode-button-hoverBackground); }
              .secondary-button {
                margin-top: 8px; padding: 6px 12px; font-size: 0.85em; width: auto;
                background-color: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground); border: 1px solid transparent;
              }
              .secondary-button:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
              .help-text { font-size: 0.9em; color: var(--vscode-description-foreground); opacity: 0.9; margin-top: 4px; }
              .checkbox-container { display: flex; align-items: center; margin-top: 1em; }
              .checkbox-container input { margin-right: 0.5em; }
              .input-group { display: flex; gap: 5px; }
              .icon-btn { width: auto; padding: 8px 10px; margin-top: 0; }
            </style>
        </head>
        <body>
          <div class="container">
            <div class="form-content">
              <h1>${t('config.title', 'Lollms VS Coder Configuration')}</h1>

              <h2>${t('config.section.general', 'General')}</h2>
              <label for="developerName">${t('config.developerName.label', 'Developer Name')}</label>
              <input type="text" id="developerName" value="${developerName}" placeholder="Your name for AI personalization" />
              <p class="help-text">${t('config.developerName.description', 'Your name, which can be used as a placeholder ({{developer_name}}) in system prompts to personalize the AI\'s responses.')}</p>
              
              <label for="language">${t('config.language.label', 'Language')}</label>
              <select id="language">
                <option value="auto" ${language === 'auto' ? 'selected' : ''}>Automatic (Follow VS Code)</option>
                <option value="en" ${language === 'en' ? 'selected' : ''}>English</option>
                <option value="fr" ${language === 'fr' ? 'selected' : ''}>French</option>
                <option value="es" ${language === 'es' ? 'selected' : ''}>Spanish</option>
                <option value="de" ${language === 'de' ? 'selected' : ''}>German</option>
                <option value="zh-cn" ${language === 'zh-cn' ? 'selected' : ''}>Chinese, Simplified</option>
                <option value="ar" ${language === 'ar' ? 'selected' : ''}>Arabic</option>
              </select>
              <p class="help-text">${t('config.language.description', 'Influences the AI\'s response language. The extension UI follows VS Code\'s display language setting.')}</p>
              
              <h2>${t('config.section.apiAndModel', 'API & Model')}</h2>
              <label for="reasoningLevel">${t('config.reasoningLevel.label', 'Reasoning Level')}</label>
              <select id="reasoningLevel">
                <option value="none" ${reasoningLevel === 'none' ? 'selected' : ''}>${t('config.reasoningLevel.none.description', 'None (Default)')}</option>
                <option value="low" ${reasoningLevel === 'low' ? 'selected' : ''}>${t('config.reasoningLevel.low.description', 'Low')}</option>
                <option value="medium" ${reasoningLevel === 'medium' ? 'selected' : ''}>${t('config.reasoningLevel.medium.description', 'Medium')}</option>
                <option value="high" ${reasoningLevel === 'high' ? 'selected' : ''}>${t('config.reasoningLevel.high.description', 'High')}</option>
              </select>
              <p class="help-text">${t('config.reasoningLevel.description', 'Select a reasoning level for the AI. This prefix command instructs models that support it to adjust their verbosity and depth of thought. Overridden by \'/no_think\' mode.')}</p>
              
              <label for="thinkingMode">${t('config.thinkingMode.label', 'Thinking Mode')}</label>
              <select id="thinkingMode">
                <option value="none" ${thinkingMode === 'none' ? 'selected' : ''}>${t('config.thinkingMode.none.description', 'None (Default)')}</option>
                <option value="chain_of_thought" ${thinkingMode === 'chain_of_thought' ? 'selected' : ''}>${t('config.thinkingMode.chain_of_thought.description', 'Chain of Thought')}</option>
                <option value="plan_and_solve" ${thinkingMode === 'plan_and_solve' ? 'selected' : ''}>${t('config.thinkingMode.plan_and_solve.description', 'Plan and Solve')}</option>
                <option value="self_critique" ${thinkingMode === 'self_critique' ? 'selected' : ''}>${t('config.thinkingMode.self_critique.description', 'Self-Critique')}</option>
                <option value="custom" ${thinkingMode === 'custom' ? 'selected' : ''}>${t('config.thinkingMode.custom.description', 'Custom')}</option>
              </select>
              <p class="help-text">${t('config.thinkingMode.description', 'Select a structured thinking technique for the AI to use. This instructs the model to follow a specific reasoning process, which can improve the quality of complex responses. Overridden by \'/no_think\' mode.')}</p>
              
              <div id="custom-thinking-prompt-container" style="display: ${thinkingMode === 'custom' ? 'block' : 'none'};">
                <label for="thinkingModeCustomPrompt">${t('config.thinkingModeCustomPrompt.label', 'Custom Thinking Prompt')}</label>
                <textarea id="thinkingModeCustomPrompt" rows="4">${thinkingModeCustomPrompt}</textarea>
                <p class="help-text">${t('config.thinkingModeCustomPrompt.description', 'Your custom instruction for the AI\'s thinking process. This is only used when \'Thinking Mode\' is set to \'Custom\'.')}</p>
              </div>
              
              <label for="apiUrl">${t('config.apiUrl.label', 'API Host')}</label>
              <input type="text" id="apiUrl" value="${apiUrl}" placeholder="http://localhost:9642" autocomplete="off" />
              <label for="apiKey">${t('config.apiKey.label', 'API Key')}</label>
              <input type="text" id="apiKey" value="${apiKey}" placeholder="Enter your Lollms API key" autocomplete="off" />
              
              <label for="modelSelect">${t('config.modelName.label', 'Chat Model')}</label>
              <div class="input-group">
                  <select id="modelSelect"></select>
                  <button id="refreshModels" type="button" class="icon-btn" title="${t('command.refresh.title', 'Refresh')}"><i class="codicon codicon-refresh"></i></button>
              </div>
              
              <label for="requestTimeout">${t('config.requestTimeout.label', 'Request Timeout (ms)')}</label>
              <input type="number" id="requestTimeout" value="${requestTimeout}" min="1000" step="1000" />
              <p class="help-text">${t('config.requestTimeout.description', 'The timeout in milliseconds for API requests. Increase this if long responses are timing out.')}</p>
              
              <div class="checkbox-container">
                  <input type="checkbox" id="disableSsl" ${disableSslVerification ? 'checked' : ''}>
                  <label for="disableSsl">${t('config.disableSslVerification.label', 'Disable SSL Verification')}</label>
              </div>
              <p class="help-text">${t('config.disableSslVerification.description', 'Disable SSL certificate verification for API requests. Use with caution for servers with self-signed certificates.')}</p>
              
              <label for="sslCertPath">${t('config.sslCertPath.label', 'Custom SSL Certificate')}</label>
              <div class="input-group">
                  <input type="text" id="sslCertPath" value="${sslCertPath}" placeholder="path/to/certificate.pem" />
                  <button id="browseCertPath" type="button" class="icon-btn" title="Browse"><i class="codicon codicon-folder-opened"></i></button>
              </div>
              <p class="help-text">${t('config.sslCertPath.description', 'Path to a custom CA certificate file (PEM/CRT) to verify the server identity.')}</p>

              <div class="checkbox-container">
                  <input type="checkbox" id="noThinkMode" ${noThinkMode ? 'checked' : ''}>
                  <label for="noThinkMode">${t('config.noThinkMode.label', 'Enable /no_think Mode')}</label>
              </div>
              <p class="help-text">${t('config.noThinkMode.description', 'Prefixes all system prompts with the /no_think command to disable the AI\'s thinking process (for models that support it).')}</p>
              
              <h2>${t('config.section.contextAndFile', 'Context & File Strategy')}</h2>
              <label for="fileUpdateMethod">${t('config.fileUpdateMethod.label', 'File Update Method')}</label>
              <select id="fileUpdateMethod">
                <option value="full_file" ${fileUpdateMethod === 'full_file' ? 'selected' : ''}>${t('config.fileUpdateMethod.full_file.description', 'Full File Content')}</option>
                <option value="diff" ${fileUpdateMethod === 'diff' ? 'selected' : ''}>${t('config.fileUpdateMethod.diff.description', 'Diff Mode')}</option>
                <option value="locate" ${fileUpdateMethod === 'locate' ? 'selected' : ''}>${t('config.fileUpdateMethod.locate.description', 'Locate and Insert/Update Mode')}</option>
                <option value="do_your_best" ${fileUpdateMethod === 'do_your_best' ? 'selected' : ''}>${t('config.fileUpdateMethod.do_your_best.description', 'Do The Best You Can')}</option>
              </select>
              <p class="help-text">${t('config.fileUpdateMethod.description', 'Choose how the AI should provide file updates.')}</p>
              
              <label for="failsafeContextSize">${t('config.failsafeContextSize.label', 'Failsafe Context Size')}</label>
              <input type="number" id="failsafeContextSize" value="${failsafeContextSize}" min="1024" step="1024" />
              <p class="help-text">${t('config.failsafeContextSize.description', 'Fallback context size to use if the API token counting fails.')}</p>

              <label for="maxImageSize">${t('config.maxImageSize.label', 'Max Image Size (px)')}</label>
              <input type="number" id="maxImageSize" value="${maxImageSize}" min="0" step="128" />
              <p class="help-text">${t('config.maxImageSize.description', 'The maximum dimension (width or height) in pixels to which large images are resized before being sent to the AI. Set to 0 to disable resizing.')}</p>
              
              <label for="contextFileExceptions">${t('config.contextFileExceptions.label', 'Context File Exceptions')}</label>
              <textarea id="contextFileExceptions" rows="8">${contextFileExceptions.join('\n')}</textarea>
              <p class="help-text">${t('config.contextFileExceptions.description', 'A list of file and folder patterns to always exclude from the AI context. Uses glob patterns (e.g., \'*.log\', \'dist/**\').')}</p>

              <h2>${t('config.section.agentAndInspector', 'Agent & Inspector')}</h2>
              <label for="agentMaxRetries">${t('config.agentMaxRetries.label', 'Agent Self-Correction Retries')}</label>
              <input type="number" id="agentMaxRetries" value="${agentMaxRetries}" min="0" max="5" />
              <p class="help-text">${t('config.agentMaxRetries.description', 'The maximum number of times the AI agent will try to fix a failed task on its own before asking for user intervention.')}</p>
              
              <div class="checkbox-container">
                  <input type="checkbox" id="enableCodeInspector" ${enableCodeInspector ? 'checked' : ''}>
                  <label for="enableCodeInspector">${t('config.enableCodeInspector.label', 'Enable Code Inspector')}</label>
              </div>
              <p class="help-text">${t('config.enableCodeInspector.description', 'Enable a button on AI-generated code blocks to check for bugs and vulnerabilities.')}</p>
              
              <label for="inspectorModelName">${t('config.inspectorModelName.label', 'Inspector Model Name')}</label>
              <div class="input-group">
                  <select id="inspectorModelName"></select>
                  <button id="refreshInspectorModels" type="button" class="icon-btn" title="${t('command.refresh.title', 'Refresh')}"><i class="codicon codicon-refresh"></i></button>
              </div>
              <p class="help-text">${t('config.inspectorModelName.description', 'Optional. Specify a different model for code inspection. If blank, the default chat model is used.')}</p>

              <h2>Tools & Search</h2>
              <label for="searchProvider">Search Provider</label>
              <select id="searchProvider">
                <option value="google_custom_search" ${searchProvider === 'google_custom_search' ? 'selected' : ''}>Google Custom Search</option>
              </select>
              <p class="help-text">Currently, only Google Custom Search is supported.</p>

              <label for="searchApiKey">Google Search API Key</label>
              <input type="text" id="searchApiKey" value="${searchApiKey}" placeholder="Enter your Google Custom Search API Key" autocomplete="off" />
              <p class="help-text">Required for the <code>search_web</code> tool. <a href="command:lollms-vs-coder.showHelp">See Help</a> for instructions.</p>

              <label for="searchCx">Google Search Engine ID (CX)</label>
              <input type="text" id="searchCx" value="${searchCx}" placeholder="Enter your Search Engine ID" autocomplete="off" />
              <p class="help-text">Required for the <code>search_web</code> tool.</p>

              <h2>${t('config.section.personas', 'Personas / System Prompts')}</h2>
              <label for="chatPersona">${t('config.chatPersona.label', 'Chat Mode Persona')}</label>
              <textarea id="chatPersona" rows="6" placeholder="e.g., You are a helpful AI assistant.">${chatPersona}</textarea>
              <p class="help-text">${t('config.chatPersona.description', 'Define the AI\'s persona and rules for the main chat. This is added to a base prompt with the critical file-output rules. Supports placeholders: {{date}}, {{time}}, {{os}}, {{developer_name}}.')}</p>
              
              <label for="agentPersona">${t('config.agentPersona.label', 'Agent Mode Persona')}</label>
              <textarea id="agentPersona" rows="4" placeholder="e.g., You are a sub-agent that follows instructions.">${agentPersona}</textarea>
              <p class="help-text">${t('config.agentPersona.description', 'Define the persona for AI agents performing autonomous tasks. Supports placeholders: {{date}}, {{time}}, {{os}}, {{developer_name}}.')}</p>
              
              <label for="codeInspectorPersona">${t('config.codeInspectorPersona.label', 'Code Inspector Persona')}</label>
              <textarea id="codeInspectorPersona" rows="4">${codeInspectorPersona}</textarea>
              <p class="help-text">${t('config.codeInspectorPersona.description', 'Customize the persona of the code inspector. This is added to a base prompt with the critical response rules.')}</p>
              
              <label for="commitMessagePersona">${t('config.commitMessagePersona.label', 'Git Commit Persona')}</label>
              <textarea id="commitMessagePersona" rows="4" placeholder="e.g., You are an expert at writing conventional git commit messages.">${commitMessagePersona}</textarea>
              <p class="help-text">${t('config.commitMessagePersona.description', 'Define the persona for the git commit message generator.')}</p>

              <h2>${t('config.section.advanced', 'Advanced')}</h2>
              <p class="help-text">${t('config.advanced.editPromptsText', 'For advanced customization, you can directly edit the JSON file that stores your prompt library.')}</p>
              <button id="editPromptsBtn" class="secondary-button">${t('command.editPromptsFile.title', 'Edit Prompts JSON File')}</button>
            </div>
            <button id="saveConfig">${t('config.saveAndClose', 'Save & Close')}</button>
          </div>
        
          <script>
            const vscode = acquireVsCodeApi();
            
            const currentModelName = "${modelName}";
            const currentInspectorModelName = "${inspectorModelName}";

            window.addEventListener('DOMContentLoaded', () => {
                const fields = {
                    language: document.getElementById('language'),
                    apiKey: document.getElementById('apiKey'),
                    apiUrl: document.getElementById('apiUrl'),
                    modelName: document.getElementById('modelSelect'),
                    developerName: document.getElementById('developerName'),
                    requestTimeout: document.getElementById('requestTimeout'),
                    disableSslVerification: document.getElementById('disableSsl'),
                    sslCertPath: document.getElementById('sslCertPath'),
                    noThinkMode: document.getElementById('noThinkMode'),
                    agentMaxRetries: document.getElementById('agentMaxRetries'),
                    maxImageSize: document.getElementById('maxImageSize'),
                    enableCodeInspector: document.getElementById('enableCodeInspector'),
                    inspectorModelName: document.getElementById('inspectorModelName'),
                    codeInspectorPersona: document.getElementById('codeInspectorPersona'),
                    chatPersona: document.getElementById('chatPersona'),
                    agentPersona: document.getElementById('agentPersona'),
                    commitMessagePersona: document.getElementById('commitMessagePersona'),
                    contextFileExceptions: document.getElementById('contextFileExceptions'),
                    fileUpdateMethod: document.getElementById('fileUpdateMethod'),
                    thinkingMode: document.getElementById('thinkingMode'),
                    thinkingModeCustomPrompt: document.getElementById('thinkingModeCustomPrompt'),
                    reasoningLevel: document.getElementById('reasoningLevel'),
                    failsafeContextSize: document.getElementById('failsafeContextSize'),
                    // Search Fields
                    searchProvider: document.getElementById('searchProvider'),
                    searchApiKey: document.getElementById('searchApiKey'),
                    searchCx: document.getElementById('searchCx')
                };
                
                const chatModelSelect = document.getElementById('modelSelect');
                const inspectorModelSelect = document.getElementById('inspectorModelName');
                const customThinkingPromptContainer = document.getElementById('custom-thinking-prompt-container');

                fields.thinkingMode.addEventListener('change', () => {
                    customThinkingPromptContainer.style.display = fields.thinkingMode.value === 'custom' ? 'block' : 'none';
                });

                document.getElementById('browseCertPath').addEventListener('click', () => {
                    vscode.postMessage({ command: 'browseCertPath' });
                });

                function postTempUpdate(key, value) {
                  vscode.postMessage({ command: 'updateTempValue', key, value });
                }

                for (const key in fields) {
                    const element = fields[key];
                    const eventType = element.type === 'checkbox' ? 'change' : 'input';
                    const valueGetter = () => {
                        if (key === 'contextFileExceptions') {
                            return element.value.split('\\n').map(s => s.trim()).filter(s => s);
                        }
                        if (element.type === 'checkbox') return element.checked;
                        if (element.type === 'number') return parseInt(element.value, 10);
                        return element.value;
                    };
                    element.addEventListener(eventType, () => postTempUpdate(key, valueGetter()));
                }
                
                function refreshModelsList(force) {
                    chatModelSelect.innerHTML = '<option>${t('progress.loading', 'Loading...')}</option>';
                    inspectorModelSelect.innerHTML = '<option>${t('progress.loading', 'Loading...')}</option>';
                    vscode.postMessage({ command: 'fetchModels', value: force });
                }

                document.getElementById('refreshModels').addEventListener('click', () => refreshModelsList(true));
                document.getElementById('refreshInspectorModels').addEventListener('click', () => refreshModelsList(true));

                document.getElementById('editPromptsBtn').addEventListener('click', () => vscode.postMessage({ command: 'editPrompts' }));
                document.getElementById('saveConfig').addEventListener('click', () => vscode.postMessage({ command: 'saveConfig' }));

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'modelsList') {
                        const createOptions = (selectElement, selectedValue) => {
                            selectElement.innerHTML = '';
                            if (Array.isArray(message.models) && message.models.length > 0) {
                                // Add a default empty option for Inspector model (optional)
                                if (selectElement === inspectorModelSelect) {
                                    const emptyOption = document.createElement('option');
                                    emptyOption.value = "";
                                    emptyOption.text = "${t('label.defaultModel', 'Same as Chat Model (Default)')}";
                                    selectElement.appendChild(emptyOption);
                                }

                                message.models.forEach(model => {
                                    const option = document.createElement('option');
                                    option.value = model.id;
                                    option.text = model.id;
                                    if (model.id === selectedValue) option.selected = true;
                                    selectElement.appendChild(option);
                                });
                            } else {
                                const noModelsOption = document.createElement('option');
                                noModelsOption.value = selectedValue;
                                noModelsOption.text = selectedValue || "${t('info.noModelsFound', 'No models found')}";
                                selectElement.appendChild(noModelsOption);
                            }
                        };

                        createOptions(chatModelSelect, currentModelName);
                        createOptions(inspectorModelSelect, currentInspectorModelName);
                    } else if (message.command === 'updateCertPath') {
                        fields.sslCertPath.value = message.path;
                    }
                });

                // Initial fetch (from cache if available)
                refreshModelsList(false);
            });
          </script>
        </body>
        </html>`;
  }
}
