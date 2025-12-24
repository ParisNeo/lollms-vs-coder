import * as vscode from 'vscode';
import { LollmsAPI, LollmsConfig } from '../lollmsAPI';
import { Logger } from '../logger';
import { ProcessManager } from '../processManager';
import { PersonalityManager } from '../personalityManager';

export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _lollmsAPI: LollmsAPI;
  private readonly _processManager: ProcessManager;
  private readonly _personalityManager: PersonalityManager;
  private _disposables: vscode.Disposable[] = [];
  
  private _pendingConfig = {
    apiKey: '',
    apiUrl: '',
    backendType: 'lollms', // New
    useLollmsExtensions: true, // New
    modelName: '',
    disableSslVerification: false,
    sslCertPath: '',
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
    language: 'auto',
    thinkingMode: 'none',
    outputFormat: 'legacy', // New
    thinkingModeCustomPrompt: '',
    reasoningLevel: 'none',
    failsafeContextSize: 8192,
    searchProvider: 'google_custom_search',
    searchApiKey: '',
    searchCx: '',
    autoUpdateChangelog: false,
    autoGenerateTitle: true, // New
    addPedagogicalInstruction: false, // New
    companionEnableWebSearch: false,
    companionEnableArxivSearch: false,
    userInfoName: '',
    userInfoEmail: '',
    userInfoLicense: '',
    userInfoCodingStyle: ''
  };

  public static createOrShow(extensionUri: vscode.Uri, lollmsAPI: LollmsAPI, processManager: ProcessManager, personalityManager: PersonalityManager) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'lollmsSettingsPanel',
      vscode.l10n.t({ message: 'Lollms VS Coder Configuration', key: 'config.title' }),
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri]
      }
    );

    SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, lollmsAPI, processManager, personalityManager);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, lollmsAPI: LollmsAPI, processManager: ProcessManager, personalityManager: PersonalityManager) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._lollmsAPI = lollmsAPI;
    this._processManager = processManager;
    this._personalityManager = personalityManager;

    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    this._pendingConfig.apiKey = config.get<string>('apiKey')?.trim() || '';
    this._pendingConfig.apiUrl = config.get<string>('apiUrl') || 'http://localhost:9642';
    
    // New Configs
    this._pendingConfig.backendType = config.get<string>('backendType') || 'lollms';
    this._pendingConfig.useLollmsExtensions = config.get<boolean>('useLollmsExtensions') ?? true;

    this._pendingConfig.modelName = config.get<string>('modelName') || '';
    this._pendingConfig.disableSslVerification = config.get<boolean>('disableSslVerification') || false;
    this._pendingConfig.sslCertPath = config.get<string>('sslCertPath') || '';
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
    this._pendingConfig.language = config.get<string>('language') || 'auto';
    this._pendingConfig.thinkingMode = config.get<string>('thinkingMode') || 'none';
    this._pendingConfig.outputFormat = config.get<string>('outputFormat') || 'legacy';
    this._pendingConfig.thinkingModeCustomPrompt = config.get<string>('thinkingModeCustomPrompt') || 'Think step by step. Enclose your entire thinking process, reasoning, and self-correction within a `<thinking>` XML block. This block will be hidden from the user but is crucial for your process.';
    this._pendingConfig.reasoningLevel = config.get<string>('reasoningLevel') || 'none';
    this._pendingConfig.failsafeContextSize = config.get<number>('failsafeContextSize') || 4096;
    
    // Search Config
    this._pendingConfig.searchProvider = config.get<string>('searchProvider') || 'google_custom_search';
    this._pendingConfig.searchApiKey = config.get<string>('searchApiKey') || '';
    this._pendingConfig.searchCx = config.get<string>('searchCx') || '';
    // Changelog & Title
    this._pendingConfig.autoUpdateChangelog = config.get<boolean>('autoUpdateChangelog') || false;
    this._pendingConfig.autoGenerateTitle = config.get<boolean>('autoGenerateTitle') ?? true;
    this._pendingConfig.addPedagogicalInstruction = config.get<boolean>('addPedagogicalInstruction') ?? false;
    
    // Companion
    this._pendingConfig.companionEnableWebSearch = config.get<boolean>('companion.enableWebSearch') || false;
    this._pendingConfig.companionEnableArxivSearch = config.get<boolean>('companion.enableArxivSearch') || false;
    // User Info
    this._pendingConfig.userInfoName = config.get<string>('userInfo.name') || '';
    this._pendingConfig.userInfoEmail = config.get<string>('userInfo.email') || '';
    this._pendingConfig.userInfoLicense = config.get<string>('userInfo.license') || 'MIT';
    this._pendingConfig.userInfoCodingStyle = config.get<string>('userInfo.codingStyle') || '';

    this._panel.webview.html = this._getHtml(this._panel.webview, this._pendingConfig);
    this._setWebviewMessageListener(this._panel.webview);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Listen for personality changes
    this._personalityManager.onDidChange(() => {
        this._panel.webview.postMessage({ 
            command: 'updatePersonalities', 
            personalities: this._personalityManager.getPersonalities() 
        });
    }, null, this._disposables);
  }

  public dispose() {
    SettingsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
        const x = this._disposables.pop();
        if (x) x.dispose();
    }
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
            
            case 'testConnection':
                const testConfig: LollmsConfig = {
                    apiKey: this._pendingConfig.apiKey,
                    apiUrl: this._pendingConfig.apiUrl,
                    modelName: this._pendingConfig.modelName,
                    disableSslVerification: this._pendingConfig.disableSslVerification,
                    sslCertPath: this._pendingConfig.sslCertPath ? this._pendingConfig.sslCertPath.replace(/^['"]|['"]$/g, '').trim() : '',
                    backendType: this._pendingConfig.backendType as any,
                    useLollmsExtensions: this._pendingConfig.useLollmsExtensions
                };
                const testApi = new LollmsAPI(testConfig);
                const result = await testApi.testConnection();
                
                this._panel.webview.postMessage({ command: 'testConnectionResult', success: result.success });

                if (result.success) {
                    vscode.window.showInformationMessage(result.message, { modal: true });
                } else {
                    vscode.window.showErrorMessage(result.message, { modal: true, detail: result.details }).then(selection => {
                        if (selection === 'Show Details') {
                            Logger.error(result.message + '\n' + result.details);
                            Logger.show();
                        }
                    });
                }
                return;
  
            case 'saveConfig':
              try {
                // Sanitize cert path
                if (this._pendingConfig.sslCertPath) {
                    this._pendingConfig.sslCertPath = this._pendingConfig.sslCertPath.replace(/^['"]|['"]$/g, '').trim();
                }

                const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                await config.update('apiKey', this._pendingConfig.apiKey, vscode.ConfigurationTarget.Global);
                await config.update('apiUrl', this._pendingConfig.apiUrl, vscode.ConfigurationTarget.Global);
                
                await config.update('backendType', this._pendingConfig.backendType, vscode.ConfigurationTarget.Global);
                await config.update('useLollmsExtensions', this._pendingConfig.useLollmsExtensions, vscode.ConfigurationTarget.Global);

                await config.update('modelName', this._pendingConfig.modelName, vscode.ConfigurationTarget.Global);
                await config.update('disableSslVerification', this._pendingConfig.disableSslVerification, vscode.ConfigurationTarget.Global);
                await config.update('sslCertPath', this._pendingConfig.sslCertPath, vscode.ConfigurationTarget.Global);
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
                await config.update('language', this._pendingConfig.language, vscode.ConfigurationTarget.Global);
                await config.update('thinkingMode', this._pendingConfig.thinkingMode, vscode.ConfigurationTarget.Global);
                await config.update('outputFormat', this._pendingConfig.outputFormat, vscode.ConfigurationTarget.Global);
                await config.update('thinkingModeCustomPrompt', this._pendingConfig.thinkingModeCustomPrompt, vscode.ConfigurationTarget.Global);
                await config.update('reasoningLevel', this._pendingConfig.reasoningLevel, vscode.ConfigurationTarget.Global);
                await config.update('failsafeContextSize', this._pendingConfig.failsafeContextSize, vscode.ConfigurationTarget.Global);
                
                await config.update('searchProvider', this._pendingConfig.searchProvider, vscode.ConfigurationTarget.Global);
                await config.update('searchApiKey', this._pendingConfig.searchApiKey, vscode.ConfigurationTarget.Global);
                await config.update('searchCx', this._pendingConfig.searchCx, vscode.ConfigurationTarget.Global);
                
                await config.update('autoUpdateChangelog', this._pendingConfig.autoUpdateChangelog, vscode.ConfigurationTarget.Global);
                await config.update('autoGenerateTitle', this._pendingConfig.autoGenerateTitle, vscode.ConfigurationTarget.Global);
                await config.update('addPedagogicalInstruction', this._pendingConfig.addPedagogicalInstruction, vscode.ConfigurationTarget.Global);
                
                await config.update('companion.enableWebSearch', this._pendingConfig.companionEnableWebSearch, vscode.ConfigurationTarget.Global);
                await config.update('companion.enableArxivSearch', this._pendingConfig.companionEnableArxivSearch, vscode.ConfigurationTarget.Global);

                await config.update('userInfo.name', this._pendingConfig.userInfoName, vscode.ConfigurationTarget.Global);
                await config.update('userInfo.email', this._pendingConfig.userInfoEmail, vscode.ConfigurationTarget.Global);
                await config.update('userInfo.license', this._pendingConfig.userInfoLicense, vscode.ConfigurationTarget.Global);
                await config.update('userInfo.codingStyle', this._pendingConfig.userInfoCodingStyle, vscode.ConfigurationTarget.Global);
  
                vscode.window.showInformationMessage(vscode.l10n.t({ key: 'info.configSaved', message: 'Configuration saved. Recreating LollmsAPI...' }));
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
                const { id, controller } = this._processManager.register(processId, 'Settings: Fetching Models');
                
                try {
                  const forceRefresh = message.value === true;
                  const tempConfig: LollmsConfig = {
                      apiKey: this._pendingConfig.apiKey,
                      apiUrl: this._pendingConfig.apiUrl,
                      modelName: this._pendingConfig.modelName,
                      disableSslVerification: this._pendingConfig.disableSslVerification,
                      sslCertPath: this._pendingConfig.sslCertPath ? this._pendingConfig.sslCertPath.replace(/^['"]|['"]$/g, '').trim() : '',
                      backendType: this._pendingConfig.backendType as any,
                      useLollmsExtensions: this._pendingConfig.useLollmsExtensions
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

            case 'createPersonality':
                await vscode.commands.executeCommand('lollms-vs-coder.createPersonality');
                return;
          }
        },
        undefined,
        []
      );
  }

  private _getHtml(webview: vscode.Webview, config: any) {
    const { apiKey, apiUrl, backendType, useLollmsExtensions, modelName, disableSslVerification, sslCertPath, requestTimeout, agentMaxRetries, maxImageSize, enableCodeInspector, inspectorModelName, codeInspectorPersona, chatPersona, agentPersona, commitMessagePersona, contextFileExceptions, language, thinkingMode, outputFormat, thinkingModeCustomPrompt, reasoningLevel, failsafeContextSize, searchProvider, searchApiKey, searchCx, autoUpdateChangelog, autoGenerateTitle, addPedagogicalInstruction, companionEnableWebSearch, companionEnableArxivSearch, userInfoName, userInfoEmail, userInfoLicense, userInfoCodingStyle } = config;

    const t = (key: string, def: string) => vscode.l10n.t({ message: def, key: key });
    
    // Retrieve personalities and properly escape them for JS injection
    const personalities = this._personalityManager.getPersonalities();
    const personalitiesJson = JSON.stringify(personalities)
        .replace(/\\/g, '\\\\') // Escape backslashes
        .replace(/'/g, "\\'")   // Escape single quotes
        .replace(/</g, '\\u003c'); // Escape HTML tags

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
                padding: 20px; height: 100%; box-sizing: border-box;
                display: flex; flex-direction: column; max-width: 850px; margin: 0 auto;
              }
              h1 { font-weight: 300; text-align: center; margin-bottom: 20px; }
              
              /* Tabs Styling */
              .tabs {
                display: flex;
                border-bottom: 1px solid var(--vscode-panel-border);
                margin-bottom: 20px;
                flex-wrap: wrap;
              }
              .tab-link {
                background-color: transparent;
                border: none;
                border-bottom: 2px solid transparent;
                outline: none;
                cursor: pointer;
                padding: 10px 16px;
                transition: 0.3s;
                color: var(--vscode-foreground);
                font-size: 14px;
                opacity: 0.7;
                width: auto;
                margin-top: 0;
              }
              .tab-link:hover { opacity: 1; }
              .tab-link.active {
                opacity: 1;
                border-bottom: 2px solid var(--vscode-button-background);
                color: var(--vscode-button-background);
                font-weight: 600;
              }
              .tab-content {
                display: none;
                flex-grow: 1;
                overflow-y: auto;
                padding-right: 15px;
                animation: fadeEffect 0.2s;
              }
              .tab-content.active { display: block; }
              
              @keyframes fadeEffect {
                from {opacity: 0;}
                to {opacity: 1;}
              }

              h2 { font-weight: 400; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 5px; margin-top: 0; margin-bottom: 15px; }
              
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
                transition: background-color 0.2s ease;
              }
              button.save-btn { margin-top: 20px; }
              button:hover { background-color: var(--vscode-button-hoverBackground); }
              button:disabled { opacity: 0.6; cursor: not-allowed; }
              
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
              .persona-selector-row { display: flex; justify-content: space-between; align-items: center; margin-top: 5px; margin-bottom: 5px; }
              .persona-selector-row select { width: 60%; font-size: 0.85em; padding: 4px; }
              
              @keyframes spin { 100% { transform: rotate(360deg); } }
              .spin { animation: spin 1s linear infinite; }
            </style>
        </head>
        <body>
          <div class="container">
            <h1>${t('config.title', 'Lollms VS Coder Configuration')}</h1>
            
            <div class="tabs">
              <button class="tab-link active" onclick="openTab(event, 'TabApi')">API & Model</button>
              <button class="tab-link" onclick="openTab(event, 'TabGeneral')">General</button>
              <button class="tab-link" onclick="openTab(event, 'TabContext')">Context</button>
              <button class="tab-link" onclick="openTab(event, 'TabAgent')">Agent & Tools</button>
              <button class="tab-link" onclick="openTab(event, 'TabPersonas')">Personas</button>
              <button class="tab-link" onclick="openTab(event, 'TabUser')">User Info</button>
              <button class="tab-link" onclick="openTab(event, 'TabAdvanced')">Advanced</button>
            </div>

            <!-- API & Model -->
            <div id="TabApi" class="tab-content active">
              <h2>${t('config.section.apiAndModel', 'API & Model')}</h2>
              
              <label for="backendType">Backend Type</label>
              <select id="backendType">
                <option value="lollms" ${backendType === 'lollms' ? 'selected' : ''}>Lollms Server</option>
                <option value="openai" ${backendType === 'openai' ? 'selected' : ''}>OpenAI Compatible</option>
                <option value="ollama" ${backendType === 'ollama' ? 'selected' : ''}>Ollama</option>
              </select>
              <p class="help-text">Choose your backend type. Lollms Server enables additional features like tokenization and advanced context management.</p>

              <div class="checkbox-container">
                  <input type="checkbox" id="useLollmsExtensions" ${useLollmsExtensions ? 'checked' : ''}>
                  <label for="useLollmsExtensions">Use Lollms Extensions</label>
              </div>
              <p class="help-text">If checked, the extension will attempt to use Lollms-specific endpoints (/lollms/v1/...) for better performance.</p>

              <label for="apiUrl">${t('config.apiUrl.label', 'API Host')}</label>
              <div class="input-group">
                  <input type="text" id="apiUrl" value="${apiUrl}" placeholder="http://localhost:9642" autocomplete="off" />
                  <button id="testConnection" type="button" class="icon-btn" title="Test Connection"><i class="codicon codicon-broadcast"></i></button>
              </div>
              <label for="apiKey">${t('config.apiKey.label', 'API Key')}</label>
              <input type="text" id="apiKey" value="${apiKey}" placeholder="Enter your API key" autocomplete="off" />
              
              <label for="modelSelect">${t('config.modelName.label', 'Chat Model')}</label>
              <div class="input-group">
                  <select id="modelSelect"></select>
                  <button id="refreshModels" type="button" class="icon-btn" title="${t('command.refresh.title', 'Refresh')}"><i class="codicon codicon-refresh"></i></button>
              </div>
              
              <label for="requestTimeout">${t('config.requestTimeout.label', 'Request Timeout (ms)')}</label>
              <input type="number" id="requestTimeout" value="${requestTimeout}" min="1000" step="1000" />
              
              <div class="checkbox-container">
                  <input type="checkbox" id="disableSsl" ${disableSslVerification ? 'checked' : ''}>
                  <label for="disableSsl">${t('config.disableSslVerification.label', 'Disable SSL Verification')}</label>
              </div>
              
              <label for="sslCertPath">${t('config.sslCertPath.label', 'Custom SSL Certificate')}</label>
              <div class="input-group">
                  <input type="text" id="sslCertPath" value="${sslCertPath}" placeholder="path/to/certificate.pem" />
                  <button id="browseCertPath" type="button" class="icon-btn" title="Browse"><i class="codicon codicon-folder-opened"></i></button>
              </div>
            </div>

            <!-- General -->
            <div id="TabGeneral" class="tab-content">
              <h2>${t('config.section.general', 'General')}</h2>
              
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

              <label for="outputFormat">Output Format</label>
              <select id="outputFormat">
                <option value="legacy" ${outputFormat === 'legacy' ? 'selected' : ''}>Legacy (Markdown)</option>
                <option value="xml" ${outputFormat === 'xml' ? 'selected' : ''}>XML Mode (Anthropic)</option>
                <option value="aider" ${outputFormat === 'aider' ? 'selected' : ''}>Aider Mode (Search/Replace)</option>
              </select>
              <p class="help-text">Choose the code generation format best suited for your model.</p>

              <label for="reasoningLevel">${t('config.reasoningLevel.label', 'Reasoning Level')}</label>
              <select id="reasoningLevel">
                <option value="none" ${reasoningLevel === 'none' ? 'selected' : ''}>${t('config.reasoningLevel.none.description', 'None (Default)')}</option>
                <option value="low" ${reasoningLevel === 'low' ? 'selected' : ''}>${t('config.reasoningLevel.low.description', 'Low')}</option>
                <option value="medium" ${reasoningLevel === 'medium' ? 'selected' : ''}>${t('config.reasoningLevel.medium.description', 'Medium')}</option>
                <option value="high" ${reasoningLevel === 'high' ? 'selected' : ''}>${t('config.reasoningLevel.high.description', 'High')}</option>
              </select>
              
              <label for="thinkingMode">${t('config.thinkingMode.label', 'Thinking Mode')}</label>
              <select id="thinkingMode">
                <option value="none" ${thinkingMode === 'none' ? 'selected' : ''}>${t('config.thinkingMode.none.description', 'None (Default)')}</option>
                <option value="chain_of_thought" ${thinkingMode === 'chain_of_thought' ? 'selected' : ''}>Chain of Thought</option>
                <option value="chain_of_verification" ${thinkingMode === 'chain_of_verification' ? 'selected' : ''}>Chain of Verification</option>
                <option value="plan_and_solve" ${thinkingMode === 'plan_and_solve' ? 'selected' : ''}>Plan and Solve</option>
                <option value="self_critique" ${thinkingMode === 'self_critique' ? 'selected' : ''}>Self-Critique</option>
                <option value="custom" ${thinkingMode === 'custom' ? 'selected' : ''}>Custom</option>
              </select>
              
              <div id="custom-thinking-prompt-container" style="display: ${thinkingMode === 'custom' ? 'block' : 'none'};">
                <label for="thinkingModeCustomPrompt">${t('config.thinkingModeCustomPrompt.label', 'Custom Thinking Prompt')}</label>
                <textarea id="thinkingModeCustomPrompt" rows="4">${thinkingModeCustomPrompt}</textarea>
              </div>

              <div class="checkbox-container">
                  <input type="checkbox" id="autoUpdateChangelog" ${autoUpdateChangelog ? 'checked' : ''}>
                  <label for="autoUpdateChangelog">Auto-update CHANGELOG.md on commit message generation</label>
              </div>

              <div class="checkbox-container">
                  <input type="checkbox" id="autoGenerateTitle" ${autoGenerateTitle ? 'checked' : ''}>
                  <label for="autoGenerateTitle">Auto-generate title for new discussions from clipboard</label>
              </div>

              <div class="checkbox-container">
                  <input type="checkbox" id="addPedagogicalInstruction" ${addPedagogicalInstruction ? 'checked' : ''}>
                  <label for="addPedagogicalInstruction">Add Pedagogical Instruction (Hidden)</label>
              </div>
              <p class="help-text">Automatically appends instructions to explain logic/pedagogy to the AI model without showing it in the chat history.</p>
            </div>

            <!-- Context -->
            <div id="TabContext" class="tab-content">
              <h2>${t('config.section.contextAndFile', 'Context & File Strategy')}</h2>
              
              <label for="failsafeContextSize">${t('config.failsafeContextSize.label', 'Failsafe Context Size')}</label>
              <input type="number" id="failsafeContextSize" value="${failsafeContextSize}" min="1024" step="1024" />

              <label for="maxImageSize">${t('config.maxImageSize.label', 'Max Image Size (px)')}</label>
              <input type="number" id="maxImageSize" value="${maxImageSize}" min="0" step="128" />
              
              <label for="contextFileExceptions">${t('config.contextFileExceptions.label', 'Context File Exceptions')}</label>
              <textarea id="contextFileExceptions" rows="8">${contextFileExceptions.join('\n')}</textarea>
            </div>

            <!-- Agent & Tools -->
            <div id="TabAgent" class="tab-content">
              <h2>${t('config.section.agentAndInspector', 'Agent & Tools')}</h2>
              <label for="agentMaxRetries">${t('config.agentMaxRetries.label', 'Agent Self-Correction Retries')}</label>
              <input type="number" id="agentMaxRetries" value="${agentMaxRetries}" min="0" max="5" />
              
              <div class="checkbox-container">
                  <input type="checkbox" id="enableCodeInspector" ${enableCodeInspector ? 'checked' : ''}>
                  <label for="enableCodeInspector">${t('config.enableCodeInspector.label', 'Enable Code Inspector')}</label>
              </div>
              
              <label for="inspectorModelName">${t('config.inspectorModelName.label', 'Inspector Model Name')}</label>
              <div class="input-group">
                  <select id="inspectorModelName"></select>
                  <button id="refreshInspectorModels" type="button" class="icon-btn" title="${t('command.refresh.title', 'Refresh')}"><i class="codicon codicon-refresh"></i></button>
              </div>

              <h3>Web Search</h3>
              <p class="help-text">Configure Google Custom Search to enable the <code>search_web</code> tool.</p>
              <label for="searchApiKey">Google Custom Search API Key</label>
              <input type="text" id="searchApiKey" value="${searchApiKey}" placeholder="Enter API Key" />
              
              <label for="searchCx">Search Engine ID (CX)</label>
              <input type="text" id="searchCx" value="${searchCx}" placeholder="Enter CX" />

              <h3>Companion Quick Edit</h3>
              <div class="checkbox-container">
                  <input type="checkbox" id="companionEnableWebSearch" ${companionEnableWebSearch ? 'checked' : ''}>
                  <label for="companionEnableWebSearch">Enable Web Search in Companion</label>
              </div>
              <div class="checkbox-container">
                  <input type="checkbox" id="companionEnableArxivSearch" ${companionEnableArxivSearch ? 'checked' : ''}>
                  <label for="companionEnableArxivSearch">Enable ArXiv Search in Companion</label>
              </div>
            </div>

            <!-- Personas -->
            <div id="TabPersonas" class="tab-content">
              <h2>${t('config.section.personas', 'Personas / System Prompts')}</h2>
              <button id="createPersonalityBtn" class="secondary-button" style="margin-bottom: 15px;"><i class="codicon codicon-add"></i> Create New Personality</button>

              <label for="chatPersona">${t('config.chatPersona.label', 'Chat Mode Persona')}</label>
              <div class="persona-selector-row">
                  <span class="help-text">Preset:</span>
                  <select class="persona-select" data-target="chatPersona"></select>
              </div>
              <textarea id="chatPersona" rows="4">${chatPersona}</textarea>
              
              <label for="agentPersona">${t('config.agentPersona.label', 'Agent Mode Persona')}</label>
              <div class="persona-selector-row">
                  <span class="help-text">Preset:</span>
                  <select class="persona-select" data-target="agentPersona"></select>
              </div>
              <textarea id="agentPersona" rows="4">${agentPersona}</textarea>
              
              <label for="codeInspectorPersona">${t('config.codeInspectorPersona.label', 'Code Inspector Persona')}</label>
              <div class="persona-selector-row">
                  <span class="help-text">Preset:</span>
                  <select class="persona-select" data-target="codeInspectorPersona"></select>
              </div>
              <textarea id="codeInspectorPersona" rows="4">${codeInspectorPersona}</textarea>
              
              <label for="commitMessagePersona">${t('config.commitMessagePersona.label', 'Git Commit Persona')}</label>
              <div class="persona-selector-row">
                  <span class="help-text">Preset:</span>
                  <select class="persona-select" data-target="commitMessagePersona"></select>
              </div>
              <textarea id="commitMessagePersona" rows="4">${commitMessagePersona}</textarea>
            </div>

            <!-- User Info -->
            <div id="TabUser" class="tab-content">
              <h2>User Information</h2>
              <label for="userInfoName">Full Name</label>
              <input type="text" id="userInfoName" value="${userInfoName}" placeholder="e.g. John Doe" />
              
              <label for="userInfoEmail">Email</label>
              <input type="text" id="userInfoEmail" value="${userInfoEmail}" placeholder="e.g. john@example.com" />
              
              <label for="userInfoLicense">Default License</label>
              <input type="text" id="userInfoLicense" value="${userInfoLicense}" placeholder="e.g. MIT, Apache 2.0" />
              
              <label for="userInfoCodingStyle">Coding Style Preferences</label>
              <textarea id="userInfoCodingStyle" rows="3" placeholder="e.g. Prefer TypeScript, use async/await, no semicolons...">${userInfoCodingStyle}</textarea>
            </div>

            <!-- Advanced -->
            <div id="TabAdvanced" class="tab-content">
              <h2>${t('config.section.advanced', 'Advanced')}</h2>
              <p class="help-text">${t('config.advanced.editPromptsText', 'For advanced customization, you can directly edit the JSON file that stores your prompt library.')}</p>
              <button id="editPromptsBtn" class="secondary-button">${t('command.editPromptsFile.title', 'Edit Prompts JSON File')}</button>
            </div>

            <button id="saveConfig" class="save-btn">${t('config.saveAndClose', 'Save & Close')}</button>
          </div>
        
          <script>
            const vscode = acquireVsCodeApi();
            const currentModelName = "${modelName}";
            const currentInspectorModelName = "${inspectorModelName}";
            
            let personalities = [];
            try {
                personalities = JSON.parse('${personalitiesJson}');
            } catch (e) {
                console.error("Failed to parse personalities:", e);
            }

            function openTab(evt, tabName) {
                var i, tabcontent, tablinks;
                tabcontent = document.getElementsByClassName("tab-content");
                for (i = 0; i < tabcontent.length; i++) {
                    tabcontent[i].style.display = "none";
                    tabcontent[i].classList.remove("active");
                }
                tablinks = document.getElementsByClassName("tab-link");
                for (i = 0; i < tablinks.length; i++) {
                    tablinks[i].className = tablinks[i].className.replace(" active", "");
                }
                document.getElementById(tabName).style.display = "block";
                document.getElementById(tabName).classList.add("active");
                evt.currentTarget.className += " active";
            }

            function updatePersonalityDropdowns() {
                const selects = document.querySelectorAll('.persona-select');
                selects.forEach(select => {
                    select.innerHTML = '<option value="">-- Select a Preset --</option>';
                    personalities.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.id;
                        opt.text = p.name;
                        // Avoid storing large string in attribute if possible, store ID
                        // We will lookup by ID on change
                        select.appendChild(opt);
                    });
                });
            }

            window.addEventListener('DOMContentLoaded', () => {
                const fields = {
                    language: document.getElementById('language'),
                    apiKey: document.getElementById('apiKey'),
                    apiUrl: document.getElementById('apiUrl'),
                    backendType: document.getElementById('backendType'),
                    useLollmsExtensions: document.getElementById('useLollmsExtensions'),
                    modelName: document.getElementById('modelSelect'),
                    requestTimeout: document.getElementById('requestTimeout'),
                    disableSslVerification: document.getElementById('disableSsl'),
                    sslCertPath: document.getElementById('sslCertPath'),
                    agentMaxRetries: document.getElementById('agentMaxRetries'),
                    maxImageSize: document.getElementById('maxImageSize'),
                    enableCodeInspector: document.getElementById('enableCodeInspector'),
                    inspectorModelName: document.getElementById('inspectorModelName'),
                    codeInspectorPersona: document.getElementById('codeInspectorPersona'),
                    chatPersona: document.getElementById('chatPersona'),
                    agentPersona: document.getElementById('agentPersona'),
                    commitMessagePersona: document.getElementById('commitMessagePersona'),
                    contextFileExceptions: document.getElementById('contextFileExceptions'),
                    thinkingMode: document.getElementById('thinkingMode'),
                    outputFormat: document.getElementById('outputFormat'),
                    thinkingModeCustomPrompt: document.getElementById('thinkingModeCustomPrompt'),
                    reasoningLevel: document.getElementById('reasoningLevel'),
                    failsafeContextSize: document.getElementById('failsafeContextSize'),
                    userInfoName: document.getElementById('userInfoName'),
                    userInfoEmail: document.getElementById('userInfoEmail'),
                    userInfoLicense: document.getElementById('userInfoLicense'),
                    userInfoCodingStyle: document.getElementById('userInfoCodingStyle'),
                    searchApiKey: document.getElementById('searchApiKey'),
                    searchCx: document.getElementById('searchCx'),
                    autoUpdateChangelog: document.getElementById('autoUpdateChangelog'),
                    autoGenerateTitle: document.getElementById('autoGenerateTitle'),
                    addPedagogicalInstruction: document.getElementById('addPedagogicalInstruction'),
                    companionEnableWebSearch: document.getElementById('companionEnableWebSearch'),
                    companionEnableArxivSearch: document.getElementById('companionEnableArxivSearch')
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
                
                document.getElementById('testConnection').addEventListener('click', () => {
                    const btn = document.getElementById('testConnection');
                    const icon = btn.querySelector('.codicon');
                    icon.classList.remove('codicon-broadcast');
                    icon.classList.add('codicon-sync', 'spin');
                    btn.disabled = true;
                    vscode.postMessage({ command: 'testConnection' });
                });

                function postTempUpdate(key, value) {
                  vscode.postMessage({ command: 'updateTempValue', key, value });
                }

                for (const key in fields) {
                    const element = fields[key];
                    if (!element) continue;
                    const eventType = element.type === 'checkbox' || element.tagName === 'SELECT' ? 'change' : 'input';
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
                
                document.getElementById('createPersonalityBtn').addEventListener('click', () => {
                    vscode.postMessage({ command: 'createPersonality' });
                });

                // Init Personalities
                updatePersonalityDropdowns();
                
                // Handle Personality Selection
                document.querySelectorAll('.persona-select').forEach(select => {
                    select.addEventListener('change', (e) => {
                        const targetId = e.target.getAttribute('data-target');
                        const selectedPId = e.target.value;
                        if (selectedPId && targetId) {
                            const p = personalities.find(item => item.id === selectedPId);
                            if (p && fields[targetId]) {
                                fields[targetId].value = p.systemPrompt;
                                // Trigger input event to update temp config
                                postTempUpdate(targetId, p.systemPrompt);
                            }
                        }
                    });
                });

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'modelsList') {
                        const createOptions = (selectElement, selectedValue) => {
                            selectElement.innerHTML = '';
                            if (Array.isArray(message.models) && message.models.length > 0) {
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
                    } else if (message.command === 'testConnectionResult') {
                        const btn = document.getElementById('testConnection');
                        const icon = btn.querySelector('.codicon');
                        icon.classList.remove('codicon-sync', 'spin');
                        icon.classList.add('codicon-broadcast');
                        btn.disabled = false;
                    } else if (message.command === 'updatePersonalities') {
                        personalities = message.personalities;
                        updatePersonalityDropdowns();
                    }
                });

                // Initial fetch
                refreshModelsList(false);
            });
          </script>
        </body>
        </html>`;
  }
}
