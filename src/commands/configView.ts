import * as vscode from 'vscode';
import { LollmsAPI, LollmsConfig } from '../lollmsAPI';
import { Logger } from '../logger';
import { ProcessManager } from '../processManager';
import { PersonalityManager } from '../personalityManager';
import { HerdParticipant } from '../utils';

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
    backendType: 'lollms',
    useLollmsExtensions: true,
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
    outputFormat: 'legacy',
    allowedFileFormats: {
        fullFile: true,
        insert: false,
        replace: false,
        delete: false
    },
    thinkingModeCustomPrompt: '',
    reasoningLevel: 'none',
    failsafeContextSize: 8192,
    searchProvider: 'google_custom_search',
    searchApiKey: '',
    searchCx: '',
    autoUpdateChangelog: false,
    autoGenerateTitle: true,
    addPedagogicalInstruction: false,
    clipboardInsertRole: 'user', 
    companionEnableWebSearch: false,
    companionEnableArxivSearch: false,
    userInfoName: '',
    userInfoEmail: '',
    userInfoLicense: '',
    userInfoCodingStyle: '',
    herdParticipants: [] as HerdParticipant[],
    herdRounds: 2
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
    
    this._pendingConfig.allowedFileFormats = config.get<any>('allowedFileFormats') || {
        fullFile: true,
        insert: false,
        replace: false,
        delete: false
    };

    this._pendingConfig.thinkingModeCustomPrompt = config.get<string>('thinkingModeCustomPrompt') || 'Think step by step. Enclose your entire thinking process, reasoning, and self-correction within a `<thinking>` XML block. This block will be hidden from the user but is crucial for your process.';
    this._pendingConfig.reasoningLevel = config.get<string>('reasoningLevel') || 'none';
    this._pendingConfig.failsafeContextSize = config.get<number>('failsafeContextSize') || 4096;
    
    this._pendingConfig.searchProvider = config.get<string>('searchProvider') || 'google_custom_search';
    this._pendingConfig.searchApiKey = config.get<string>('searchApiKey') || '';
    this._pendingConfig.searchCx = config.get<string>('searchCx') || '';
    this._pendingConfig.autoUpdateChangelog = config.get<boolean>('autoUpdateChangelog') || false;
    this._pendingConfig.autoGenerateTitle = config.get<boolean>('autoGenerateTitle') ?? true;
    this._pendingConfig.addPedagogicalInstruction = config.get<boolean>('addPedagogicalInstruction') ?? false;
    this._pendingConfig.clipboardInsertRole = config.get<string>('clipboardInsertRole') || 'user';
    
    this._pendingConfig.companionEnableWebSearch = config.get<boolean>('companion.enableWebSearch') || false;
    this._pendingConfig.companionEnableArxivSearch = config.get<boolean>('companion.enableArxivSearch') || false;
    this._pendingConfig.userInfoName = config.get<string>('userInfo.name') || '';
    this._pendingConfig.userInfoEmail = config.get<string>('userInfo.email') || '';
    this._pendingConfig.userInfoLicense = config.get<string>('userInfo.license') || 'MIT';
    this._pendingConfig.userInfoCodingStyle = config.get<string>('userInfo.codingStyle') || '';
    
    this._pendingConfig.herdParticipants = config.get<HerdParticipant[]>('herdParticipants') || [];
    this._pendingConfig.herdRounds = config.get<number>('herdRounds') || 2;

    this._panel.webview.html = this._getHtml(this._panel.webview, this._pendingConfig);
    this._setWebviewMessageListener(this._panel.webview);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

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
            
            case 'updateFormatValue':
              if (message.key) {
                  (this._pendingConfig.allowedFileFormats as any)[message.key] = message.value;
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
                            Logger.error('Connection test failed: ' + result.message + '\n' + result.details);
                            Logger.show();
                        }
                    });
                }
                return;
  
            case 'saveConfig':
              try {
                Logger.info('=== START SAVE CONFIGURATION ===');
                
                if (this._pendingConfig.sslCertPath) {
                  this._pendingConfig.sslCertPath = this._pendingConfig.sslCertPath
                    .replace(/^['"]|['"]$/g, '')
                    .trim();
                }

                const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                const target = vscode.workspace.workspaceFolders?.length
                  ? vscode.ConfigurationTarget.Workspace
                  : vscode.ConfigurationTarget.Global;

                const failures: { key: string; error: string }[] = [];

                const safeUpdate = async (key: string, value: any) => {
                  try {
                    Logger.debug(`Updating config key '${key}'`, value);
                    await config.update(key, value, target);
                    Logger.debug(`Successfully updated '${key}'`);
                  } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : String(e);
                    Logger.error(`Failed to update config key '${key}': ${errorMsg}`, e);
                    failures.push({ key, error: errorMsg });
                  }
                };

                const updates: [string, any][] = [
                  ['apiKey', this._pendingConfig.apiKey],
                  ['apiUrl', this._pendingConfig.apiUrl],
                  ['backendType', this._pendingConfig.backendType],
                  ['useLollmsExtensions', this._pendingConfig.useLollmsExtensions],
                  ['modelName', this._pendingConfig.modelName],
                  ['disableSslVerification', this._pendingConfig.disableSslVerification],
                  ['sslCertPath', this._pendingConfig.sslCertPath],
                  ['requestTimeout', this._pendingConfig.requestTimeout],
                  ['agentMaxRetries', this._pendingConfig.agentMaxRetries],
                  ['maxImageSize', this._pendingConfig.maxImageSize],
                  ['enableCodeInspector', this._pendingConfig.enableCodeInspector],
                  ['inspectorModelName', this._pendingConfig.inspectorModelName],
                  ['codeInspectorPersona', this._pendingConfig.codeInspectorPersona],
                  ['chatPersona', this._pendingConfig.chatPersona],
                  ['agentPersona', this._pendingConfig.agentPersona],
                  ['commitMessagePersona', this._pendingConfig.commitMessagePersona],
                  ['contextFileExceptions', this._pendingConfig.contextFileExceptions],
                  ['language', this._pendingConfig.language],
                  ['thinkingMode', this._pendingConfig.thinkingMode],
                  ['outputFormat', this._pendingConfig.outputFormat],
                  ['allowedFileFormats', this._pendingConfig.allowedFileFormats],
                  ['thinkingModeCustomPrompt', this._pendingConfig.thinkingModeCustomPrompt],
                  ['reasoningLevel', this._pendingConfig.reasoningLevel],
                  ['failsafeContextSize', this._pendingConfig.failsafeContextSize],
                  ['searchProvider', this._pendingConfig.searchProvider],
                  ['searchApiKey', this._pendingConfig.searchApiKey],
                  ['searchCx', this._pendingConfig.searchCx],
                  ['autoUpdateChangelog', this._pendingConfig.autoUpdateChangelog],
                  ['autoGenerateTitle', this._pendingConfig.autoGenerateTitle],
                  ['addPedagogicalInstruction', this._pendingConfig.addPedagogicalInstruction],
                  ['clipboardInsertRole', this._pendingConfig.clipboardInsertRole],
                  ['companion.enableWebSearch', this._pendingConfig.companionEnableWebSearch],
                  ['companion.enableArxivSearch', this._pendingConfig.companionEnableArxivSearch],
                  ['userInfo.name', this._pendingConfig.userInfoName],
                  ['userInfo.email', this._pendingConfig.userInfoEmail],
                  ['userInfo.license', this._pendingConfig.userInfoLicense],
                  ['userInfo.codingStyle', this._pendingConfig.userInfoCodingStyle],
                  ['herdParticipants', this._pendingConfig.herdParticipants],
                  ['herdRounds', this._pendingConfig.herdRounds],
                ];

                for (const [key, value] of updates) {
                  await safeUpdate(key, value);
                }

                if (failures.length === 0) {
                  vscode.window.showInformationMessage(
                    vscode.l10n.t({ key: 'info.configSaved', message: 'Configuration saved. Recreating LollmsAPI...' })
                  );
                  Logger.info('Configuration saved successfully. Recreating LollmsAPI...');
                  await vscode.commands.executeCommand('lollmsApi.recreateClient');
                  SettingsPanel.currentPanel?.dispose();
                } else {
                  const errorDetails = failures.map(f => `  • ${f.key}: ${f.error}`).join('\n');
                  const failMsg = `Configuration saved with ${failures.length} error(s):\n\n${errorDetails}\n\nCheck the Log tab for full details.`;
                  vscode.window.showErrorMessage(failMsg, { modal: true });
                  Logger.error('Configuration saved with failures', { failures });
                }

                Logger.info('=== END SAVE CONFIGURATION ===');
              } catch (err) {
                vscode.window.showErrorMessage('Failed to save configuration (unexpected error).');
                Logger.error('Unexpected error during configuration save', err);
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

            case 'requestLog':
                const logContent = Logger.getLogContent();
                this._panel.webview.postMessage({ 
                    command: 'logData', 
                    content: logContent 
                });
                return;
          }
        },
        undefined,
        []
      );
  }

  private _getHtml(webview: vscode.Webview, config: any) {
    const { apiKey, apiUrl, backendType, useLollmsExtensions, modelName, disableSslVerification, sslCertPath, requestTimeout, agentMaxRetries, maxImageSize, enableCodeInspector, inspectorModelName, codeInspectorPersona, chatPersona, agentPersona, commitMessagePersona, contextFileExceptions, language, thinkingMode, outputFormat, allowedFileFormats, thinkingModeCustomPrompt, reasoningLevel, failsafeContextSize, searchProvider, searchApiKey, searchCx, autoUpdateChangelog, autoGenerateTitle, addPedagogicalInstruction, clipboardInsertRole, companionEnableWebSearch, companionEnableArxivSearch, userInfoName, userInfoEmail, userInfoLicense, userInfoCodingStyle, herdParticipants, herdRounds } = config;

    const t = (key: string, def: string) => vscode.l10n.t({ message: def, key: key });
    
    const personalities = this._personalityManager.getPersonalities();
    const personalitiesJson = JSON.stringify(personalities)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/</g, '\\u003c');
    
    const participantsJson = JSON.stringify(herdParticipants)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>${t('config.title', 'Lollms VS Coder Configuration')}</title>
            <link href="${webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'))}" rel="stylesheet" />
            <style>
              :root {
                --primary-accent: #007acc;
                --primary-accent-hover: #005a9e;
                --success-color: #4ec9b0;
                --warning-color: #ce9178;
                --error-color: #f48771;
                --border-radius: 8px;
                --border-radius-sm: 4px;
                --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.15);
                --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.2);
                --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
              }

              body, html {
                height: 100%; width:100%; margin: 0; padding: 0;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                background: linear-gradient(135deg, var(--vscode-editor-background) 0%, color-mix(in srgb, var(--vscode-editor-background) 95%, var(--primary-accent)) 100%);
                color: var(--vscode-editor-foreground);
                font-size: 14px;
                line-height: 1.6;
              }
              
              .container {
                padding: 32px 24px; 
                height: 100%; 
                box-sizing: border-box;
                display: flex; 
                flex-direction: column; 
                max-width: 1000px; 
                margin: 0 auto;
              }
              
              h1 { 
                font-weight: 600; 
                text-align: center; 
                margin-bottom: 32px;
                font-size: 28px;
                background: linear-gradient(135deg, var(--primary-accent), var(--success-color));
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
                letter-spacing: -0.5px;
              }
              
              /* Enhanced Tabs */
              .tabs {
                display: flex;
                background: var(--vscode-editorWidget-background);
                border-radius: var(--border-radius);
                padding: 6px;
                margin-bottom: 24px;
                flex-wrap: wrap;
                gap: 4px;
                box-shadow: var(--shadow-sm);
                border: 1px solid var(--vscode-panel-border);
              }
              
              .tab-link {
                background: transparent;
                border: none;
                outline: none;
                cursor: pointer;
                padding: 10px 18px;
                transition: var(--transition);
                color: var(--vscode-foreground);
                font-size: 13px;
                font-weight: 500;
                opacity: 0.7;
                border-radius: var(--border-radius-sm);
                position: relative;
                overflow: hidden;
              }
              
              .tab-link::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(135deg, var(--primary-accent), var(--success-color));
                opacity: 0;
                transition: var(--transition);
                z-index: -1;
              }
              
              .tab-link:hover { 
                opacity: 1;
                transform: translateY(-1px);
              }
              
              .tab-link.active {
                opacity: 1;
                color: white;
                font-weight: 600;
                box-shadow: var(--shadow-sm);
              }
              
              .tab-link.active::before {
                opacity: 1;
              }
              
              /* Tab Content */
              .tab-content {
                display: none;
                flex-grow: 1;
                overflow-y: auto;
                padding: 24px;
                background: var(--vscode-editor-background);
                border-radius: var(--border-radius);
                box-shadow: var(--shadow-sm);
                border: 1px solid var(--vscode-panel-border);
                animation: slideIn 0.3s ease-out;
              }
              
              .tab-content.active { 
                display: block; 
              }
              
              @keyframes slideIn {
                from {
                  opacity: 0;
                  transform: translateY(10px);
                }
                to {
                  opacity: 1;
                  transform: translateY(0);
                }
              }

              /* Section Headers */
              h2 { 
                font-weight: 600; 
                font-size: 20px;
                border-bottom: 2px solid var(--primary-accent);
                padding-bottom: 12px; 
                margin-top: 0; 
                margin-bottom: 24px;
                color: var(--primary-accent);
              }
              
              h3 { 
                font-size: 16px; 
                margin-top: 28px; 
                margin-bottom: 16px; 
                font-weight: 600;
                color: var(--success-color);
                display: flex;
                align-items: center;
                gap: 8px;
              }
              
              h3::before {
                content: '';
                width: 4px;
                height: 20px;
                background: var(--success-color);
                border-radius: 2px;
              }

              /* Form Elements */
              label { 
                display: block; 
                margin-top: 18px; 
                margin-bottom: 8px; 
                font-weight: 600; 
                font-size: 13px; 
                color: var(--vscode-input-foreground);
                letter-spacing: 0.2px;
              }
              
              input[type="text"], 
              input[type="number"], 
              input[list], 
              textarea, 
              select {
                width: 100%; 
                padding: 10px 14px; 
                border: 2px solid var(--vscode-input-border);
                border-radius: var(--border-radius-sm); 
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground); 
                font-size: 13px; 
                box-sizing: border-box;
                font-family: inherit;
                transition: var(--transition);
              }
              
              input:focus, 
              textarea:focus, 
              select:focus {
                outline: none;
                border-color: var(--primary-accent);
                box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-accent) 20%, transparent);
              }
              
              textarea { 
                resize: vertical; 
                min-height: 100px;
                font-family: 'Consolas', 'Courier New', monospace;
              }
              
              /* Buttons */
              button {
                background: linear-gradient(135deg, var(--primary-accent), color-mix(in srgb, var(--primary-accent) 85%, var(--success-color)));
                color: white;
                border: none; 
                padding: 12px 24px;
                font-size: 14px; 
                font-weight: 600; 
                border-radius: var(--border-radius-sm); 
                cursor: pointer;
                transition: var(--transition);
                box-shadow: var(--shadow-sm);
                position: relative;
                overflow: hidden;
              }
              
              button::before {
                content: '';
                position: absolute;
                top: 50%;
                left: 50%;
                width: 0;
                height: 0;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.3);
                transform: translate(-50%, -50%);
                transition: width 0.6s, height 0.6s;
              }
              
              button:hover::before {
                width: 300px;
                height: 300px;
              }
              
              button.save-btn { 
                margin-top: 32px;
                width: 100%;
                padding: 14px;
                font-size: 15px;
              }
              
              button:hover { 
                transform: translateY(-2px);
                box-shadow: var(--shadow-md);
              }
              
              button:active {
                transform: translateY(0);
              }
              
              button:disabled { 
                opacity: 0.5; 
                cursor: not-allowed;
                transform: none;
              }
              
              .secondary-button {
                margin-top: 12px; 
                padding: 8px 16px; 
                font-size: 13px; 
                width: auto;
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
              }
              
              .icon-btn { 
                width: auto; 
                padding: 10px 14px; 
                margin-top: 0;
                min-width: 44px;
              }
              
              /* Helper Text */
              .help-text { 
                font-size: 12px; 
                color: var(--vscode-descriptionForeground); 
                margin-top: 6px;
                font-style: italic;
              }
              
              /* Checkbox */
              .checkbox-container { 
                display: flex; 
                align-items: center; 
                margin-top: 14px;
                padding: 12px;
                background: var(--vscode-editorWidget-background);
                border-radius: var(--border-radius-sm);
                border: 1px solid transparent;
                transition: var(--transition);
              }
              
              .checkbox-container:hover {
                border-color: var(--primary-accent);
              }
              
              .checkbox-container input { 
                margin-right: 10px; 
                width: 18px;
                height: 18px;
                cursor: pointer;
                accent-color: var(--primary-accent);
              }
              
              .checkbox-container label {
                margin: 0;
                cursor: pointer;
              }
              
              /* Input Groups */
              .input-group { 
                display: flex; 
                gap: 8px;
              }
              
              .input-group input,
              .input-group select {
                flex: 1;
              }
              
              /* Persona Selector */
              .persona-selector-row { 
                display: flex; 
                justify-content: space-between; 
                align-items: center; 
                margin-top: 8px; 
                margin-bottom: 8px;
                padding: 8px 12px;
                background: var(--vscode-editorWidget-background);
                border-radius: var(--border-radius-sm);
              }
              
              .persona-selector-row select { 
                width: 60%; 
                font-size: 12px; 
                padding: 6px 10px;
              }
              
              /* Grid Layout */
              .grid-2 { 
                display: grid; 
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
                gap: 12px; 
                margin-top: 12px;
              }

              /* Participant Row */
              .participant-row {
                display: flex;
                gap: 12px;
                align-items: center;
                margin-bottom: 12px;
                background: var(--vscode-editorWidget-background);
                padding: 14px;
                border-radius: var(--border-radius-sm);
                border: 2px solid var(--vscode-widget-border);
                transition: var(--transition);
              }
              
              .participant-row:hover {
                border-color: var(--primary-accent);
                box-shadow: var(--shadow-sm);
              }
              
              .participant-row select { 
                flex: 1;
              }
              
              .remove-btn { 
                width: auto; 
                background: var(--error-color);
                padding: 8px 14px;
              }
              
              .remove-btn:hover { 
                background: color-mix(in srgb, var(--error-color) 85%, black);
              }

              /* Log Container */
              .log-container {
                background: var(--vscode-editorWidget-background);
                padding: 16px;
                border-radius: var(--border-radius-sm);
                border: 2px solid var(--vscode-widget-border);
                height: 450px;
                overflow: auto;
                position: relative;
                font-family: 'Consolas', 'Courier New', monospace;
                font-size: 12px;
              }
              
              .log-container pre {
                margin: 0;
                white-space: pre-wrap;
                word-break: break-word;
                color: var(--vscode-editor-foreground);
              }
              
              .copy-log-btn {
                position: absolute;
                top: 12px;
                right: 12px;
                padding: 8px 16px;
                font-size: 12px;
                z-index: 10;
              }

              /* Scrollbar Styling */
              .tab-content::-webkit-scrollbar,
              .log-container::-webkit-scrollbar {
                width: 10px;
              }
              
              .tab-content::-webkit-scrollbar-track,
              .log-container::-webkit-scrollbar-track {
                background: var(--vscode-scrollbarSlider-background);
                border-radius: 5px;
              }
              
              .tab-content::-webkit-scrollbar-thumb,
              .log-container::-webkit-scrollbar-thumb {
                background: var(--vscode-scrollbarSlider-hoverBackground);
                border-radius: 5px;
              }
              
              .tab-content::-webkit-scrollbar-thumb:hover,
              .log-container::-webkit-scrollbar-thumb:hover {
                background: var(--vscode-scrollbarSlider-activeBackground);
              }

              /* Animations */
              @keyframes spin { 
                100% { transform: rotate(360deg); } 
              }
              
              .spin { 
                animation: spin 1s linear infinite; 
              }
              
              /* Status Indicator */
              .status-indicator {
                display: inline-block;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                margin-right: 6px;
                animation: pulse 2s ease-in-out infinite;
              }
              
              @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
              }
              
              .status-indicator.connected {
                background: var(--success-color);
              }
              
              .status-indicator.disconnected {
                background: var(--error-color);
              }

              /* Responsive Design */
              @media (max-width: 768px) {
                .container {
                  padding: 20px 16px;
                }
                
                h1 {
                  font-size: 24px;
                  margin-bottom: 24px;
                }
                
                .tabs {
                  padding: 4px;
                }
                
                .tab-link {
                  padding: 8px 12px;
                  font-size: 12px;
                }
                
                .tab-content {
                  padding: 16px;
                }
                
                .grid-2 {
                  grid-template-columns: 1fr;
                }
              }
            </style>
        </head>
        <body>
          <div class="container">
            <h1>⚙️ ${t('config.title', 'Lollms VS Coder Configuration')}</h1>
          
            <div class="tabs">
              <button class="tab-link active" onclick="openTab(event, 'TabApi')">🔌 API & Model</button>
              <button class="tab-link" onclick="openTab(event, 'TabGeneral')">⚡ General</button>
              <button class="tab-link" onclick="openTab(event, 'TabContext')">📦 Context</button>
              <button class="tab-link" onclick="openTab(event, 'TabAgent')">🤖 Agent & Tools</button>
              <button class="tab-link" onclick="openTab(event, 'TabHerd')">🐂 Herd Mode</button>
              <button class="tab-link" onclick="openTab(event, 'TabPersonas')">🎭 Personas</button>
              <button class="tab-link" onclick="openTab(event, 'TabUser')">👤 User Info</button>
              <button class="tab-link" onclick="openTab(event, 'TabAdvanced')">🔧 Advanced</button>
              <button class="tab-link" onclick="openTab(event, 'TabLog')">📋 Log</button>
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

              <div class="checkbox-container">
                  <input type="checkbox" id="useLollmsExtensions" ${useLollmsExtensions ? 'checked' : ''}>
                  <label for="useLollmsExtensions">Use Lollms Extensions</label>
              </div>

              <label for="apiUrl">${t('config.apiUrl.label', 'API Host')}</label>
              <div class="input-group">
                  <input type="text" id="apiUrl" value="${apiUrl}" placeholder="http://localhost:9642" autocomplete="off" />
                  <button id="testConnection" type="button" class="icon-btn" title="Test Connection"><i class="codicon codicon-broadcast"></i></button>
              </div>
              <label for="apiKey">${t('config.apiKey.label', 'API Key')}</label>
              <input type="text" id="apiKey" value="${apiKey}" placeholder="Enter your API key" autocomplete="off" />
              
              <label for="modelSelect">${t('config.modelName.label', 'Chat Model')}</label>
              <div class="input-group">
                  <select id="modelSelect" class="model-dropdown"></select>
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
                <option value="auto" ${language === 'auto' ? 'selected' : ''}>Automatic</option>
                <option value="en" ${language === 'en' ? 'selected' : ''}>English</option>
                <option value="fr" ${language === 'fr' ? 'selected' : ''}>French</option>
                <option value="es" ${language === 'es' ? 'selected' : ''}>Spanish</option>
                <option value="de" ${language === 'de' ? 'selected' : ''}>German</option>
                <option value="zh-cn" ${language === 'zh-cn' ? 'selected' : ''}>Chinese, Simplified</option>
                <option value="ar" ${language === 'ar' ? 'selected' : ''}>Arabic</option>
              </select>

              <label for="outputFormat">Global Code Format</label>
              <select id="outputFormat">
                <option value="legacy" ${outputFormat === 'legacy' ? 'selected' : ''}>Legacy (Markdown)</option>
                <option value="xml" ${outputFormat === 'xml' ? 'selected' : ''}>XML Mode (Anthropic)</option>
                <option value="aider" ${outputFormat === 'aider' ? 'selected' : ''}>Aider Mode (Search/Replace)</option>
              </select>

              <h3>Default Allowed Modification Formats</h3>
              <p class="help-text">Select which formats the AI is allowed to use. These can be overridden per-discussion.</p>
              <div class="grid-2">
                  <div class="checkbox-container">
                      <input type="checkbox" id="fmt-fullFile" ${allowedFileFormats.fullFile ? 'checked' : ''}>
                      <label for="fmt-fullFile">Full File (File:)</label>
                  </div>
                  <div class="checkbox-container">
                      <input type="checkbox" id="fmt-insert" ${allowedFileFormats.insert ? 'checked' : ''}>
                      <label for="fmt-insert">Insert</label>
                  </div>
                  <div class="checkbox-container">
                      <input type="checkbox" id="fmt-replace" ${allowedFileFormats.replace ? 'checked' : ''}>
                      <label for="fmt-replace">Replace</label>
                  </div>
                  <div class="checkbox-container">
                      <input type="checkbox" id="fmt-delete" ${allowedFileFormats.delete ? 'checked' : ''}>
                      <label for="fmt-delete">Delete Code</label>
                  </div>
              </div>

              <label for="reasoningLevel">${t('config.reasoningLevel.label', 'Reasoning Level')}</label>
              <select id="reasoningLevel">
                <option value="none" ${reasoningLevel === 'none' ? 'selected' : ''}>None</option>
                <option value="low" ${reasoningLevel === 'low' ? 'selected' : ''}>Low</option>
                <option value="medium" ${reasoningLevel === 'medium' ? 'selected' : ''}>Medium</option>
                <option value="high" ${reasoningLevel === 'high' ? 'selected' : ''}>High</option>
              </select>
              
              <label for="thinkingMode">${t('config.thinkingMode.label', 'Thinking Mode')}</label>
              <select id="thinkingMode">
                <option value="none" ${thinkingMode === 'none' ? 'selected' : ''}>None</option>
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
                  <label for="autoUpdateChangelog">Auto-update CHANGELOG.md</label>
              </div>

              <div class="checkbox-container">
                  <input type="checkbox" id="autoGenerateTitle" ${autoGenerateTitle ? 'checked' : ''}>
                  <label for="autoGenerateTitle">Auto-generate discussion titles</label>
              </div>
              
              <div class="checkbox-container">
                  <input type="checkbox" id="addPedagogicalInstruction" ${addPedagogicalInstruction ? 'checked' : ''}>
                  <label for="addPedagogicalInstruction">Add Pedagogical Instruction (Hidden)</label>
              </div>

              <label for="clipboardInsertRole">Clipboard Paste Role</label>
              <select id="clipboardInsertRole">
                <option value="user" ${clipboardInsertRole === 'user' ? 'selected' : ''}>User Message</option>
                <option value="assistant" ${clipboardInsertRole === 'assistant' ? 'selected' : ''}>Assistant Message (Context)</option>
              </select>
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
                  <select id="inspectorModelName" class="model-dropdown"></select>
                  <button id="refreshInspectorModels" type="button" class="icon-btn" title="${t('command.refresh.title', 'Refresh')}"><i class="codicon codicon-refresh"></i></button>
              </div>

              <h3>Web Search</h3>
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

            <!-- Herd Mode -->
            <div id="TabHerd" class="tab-content">
              <h2>Herd Mode 🐂</h2>
              <p class="help-text">Configure participants for multi-model brainstorming sessions.</p>
              
              <label for="herdRounds">Number of Rounds</label>
              <input type="number" id="herdRounds" value="${herdRounds}" min="1" max="10" />

              <h3>Participants</h3>
              <div id="herd-participants-list">
              </div>
              <button id="addParticipantBtn" class="secondary-button" style="margin-top:10px;">
                  <i class="codicon codicon-add"></i> Add Participant
              </button>
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
              <textarea id="userInfoCodingStyle" rows="3" placeholder="Style preferences...">${userInfoCodingStyle}</textarea>
            </div>

            <!-- Advanced -->
            <div id="TabAdvanced" class="tab-content">
              <h2>${t('config.section.advanced', 'Advanced')}</h2>
              <button id="editPromptsBtn" class="secondary-button">${t('command.editPromptsFile.title', 'Edit Prompts JSON File')}</button>
            </div>

            <!-- Log Tab -->
            <div id="TabLog" class="tab-content">
              <h2>Extension Log</h2>
              <p class="help-text">View recent extension activity and troubleshoot issues.</p>
              <div class="log-container">
                <button class="copy-log-btn" id="copyLogBtn">Copy</button>
                <pre id="logContent">Loading log...</pre>
              </div>
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
            } catch (e) {}

            let herdParticipants = [];
            try {
                herdParticipants = JSON.parse('${participantsJson}');
            } catch (e) {}

            let loadedModels = [];

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
                
                if (tabName === 'TabLog') {
                    vscode.postMessage({ command: 'requestLog' });
                }
            }

            function updatePersonalityDropdowns() {
                const selects = document.querySelectorAll('.persona-select');
                selects.forEach(select => {
                    select.innerHTML = '<option value="">-- Select a Preset --</option>';
                    personalities.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.id;
                        opt.text = p.name;
                        select.appendChild(opt);
                    });
                });
                
                const herdSelects = document.querySelectorAll('.herd-persona-select');
                herdSelects.forEach(select => {
                    const currentVal = select.value;
                    select.innerHTML = '';
                    personalities.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.id;
                        opt.text = p.name;
                        select.appendChild(opt);
                    });
                    select.value = currentVal;
                });
            }

            function populateModelDropdown(selectElement, selectedValue) {
                selectElement.innerHTML = '';
                if (loadedModels.length > 0) {
                    if (selectElement.id === 'inspectorModelName') {
                        const emptyOption = document.createElement('option');
                        emptyOption.value = "";
                        emptyOption.text = "Same as Chat Model (Default)";
                        selectElement.appendChild(emptyOption);
                    }
                    loadedModels.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.id;
                        option.text = model.id;
                        selectElement.appendChild(option);
                    });
                    if (selectedValue) selectElement.value = selectedValue;
                } else {
                    const noModelsOption = document.createElement('option');
                    noModelsOption.value = selectedValue;
                    noModelsOption.text = selectedValue || "Loading...";
                    selectElement.appendChild(noModelsOption);
                }
            }

            function renderHerdParticipants() {
                const container = document.getElementById('herd-participants-list');
                container.innerHTML = '';
                
                herdParticipants.forEach((p, index) => {
                    const row = document.createElement('div');
                    row.className = 'participant-row';
                    
                    const modelSelect = document.createElement('select');
                    modelSelect.className = 'herd-model-select';
                    populateModelDropdown(modelSelect, p.model);
                    modelSelect.onchange = (e) => {
                        herdParticipants[index].model = e.target.value;
                        postTempUpdate('herdParticipants', herdParticipants);
                    };

                    const personaSelect = document.createElement('select');
                    personaSelect.className = 'herd-persona-select';
                    personalities.forEach(person => {
                        const opt = document.createElement('option');
                        opt.value = person.id;
                        opt.text = person.name;
                        personaSelect.appendChild(opt);
                    });
                    personaSelect.value = p.personality;
                    personaSelect.onchange = (e) => {
                        herdParticipants[index].personality = e.target.value;
                        postTempUpdate('herdParticipants', herdParticipants);
                    };

                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'remove-btn icon-btn';
                    removeBtn.innerHTML = '<i class="codicon codicon-trash"></i>';
                    removeBtn.onclick = () => {
                        herdParticipants.splice(index, 1);
                        renderHerdParticipants();
                        postTempUpdate('herdParticipants', herdParticipants);
                    };

                    row.appendChild(modelSelect);
                    row.appendChild(personaSelect);
                    row.appendChild(removeBtn);
                    container.appendChild(row);
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
                    clipboardInsertRole: document.getElementById('clipboardInsertRole'),
                    companionEnableWebSearch: document.getElementById('companionEnableWebSearch'),
                    companionEnableArxivSearch: document.getElementById('companionEnableArxivSearch'),
                    herdRounds: document.getElementById('herdRounds')
                };

                const formatFields = {
                    fullFile: document.getElementById('fmt-fullFile'),
                    insert: document.getElementById('fmt-insert'),
                    replace: document.getElementById('fmt-replace'),
                    delete: document.getElementById('fmt-delete')
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

                document.getElementById('addParticipantBtn').addEventListener('click', () => {
                    herdParticipants.push({ model: currentModelName, personality: 'default_coder' });
                    renderHerdParticipants();
                    postTempUpdate('herdParticipants', herdParticipants);
                });

                document.getElementById('copyLogBtn').addEventListener('click', () => {
                    const logText = document.getElementById('logContent').textContent;
                    navigator.clipboard.writeText(logText).then(() => {
                        const btn = document.getElementById('copyLogBtn');
                        btn.textContent = 'Copied!';
                        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
                    }).catch(err => {
                        console.error('Failed to copy log:', err);
                    });
                });

                function postTempUpdate(key, value) {
                  vscode.postMessage({ command: 'updateTempValue', key, value });
                }

                for (const key in fields) {
                    const element = fields[key];
                    if (!element) continue;
                    const eventType = element.type === 'checkbox' || element.tagName === 'SELECT' ? 'change' : 'input';
                    element.addEventListener(eventType, () => {
                        let val;
                        if (key === 'contextFileExceptions') {
                            val = element.value.split('\\n').map(s => s.trim()).filter(s => s);
                        } else if (element.type === 'checkbox') {
                            val = element.checked;
                        } else if (element.type === 'number') {
                            val = parseInt(element.value, 10);
                        } else {
                            val = element.value;
                        }
                        postTempUpdate(key, val);
                    });
                }

                for (const key in formatFields) {
                    const element = formatFields[key];
                    if (!element) continue;
                    element.addEventListener('change', () => {
                        vscode.postMessage({ command: 'updateFormatValue', key: key, value: element.checked });
                    });
                }
                
                function refreshModelsList(force) {
                    chatModelSelect.innerHTML = '<option>Loading...</option>';
                    inspectorModelSelect.innerHTML = '<option>Loading...</option>';
                    vscode.postMessage({ command: 'fetchModels', value: force });
                }

                document.getElementById('refreshModels').addEventListener('click', () => refreshModelsList(true));
                document.getElementById('refreshInspectorModels').addEventListener('click', () => refreshModelsList(true));
                document.getElementById('editPromptsBtn').addEventListener('click', () => vscode.postMessage({ command: 'editPrompts' }));
                document.getElementById('saveConfig').addEventListener('click', () => vscode.postMessage({ command: 'saveConfig' }));
                document.getElementById('createPersonalityBtn').addEventListener('click', () => vscode.postMessage({ command: 'createPersonality' }));

                updatePersonalityDropdowns();
                renderHerdParticipants();
                
                document.querySelectorAll('.persona-select').forEach(select => {
                    select.addEventListener('change', (e) => {
                        const targetId = e.target.getAttribute('data-target');
                        const selectedPId = e.target.value;
                        if (selectedPId && targetId) {
                            const p = personalities.find(item => item.id === selectedPId);
                            if (p && fields[targetId]) {
                                fields[targetId].value = p.systemPrompt;
                                postTempUpdate(targetId, p.systemPrompt);
                            }
                        }
                    });
                });

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'modelsList') {
                        if (Array.isArray(message.models) && message.models.length > 0) {
                            loadedModels = message.models;
                        } else {
                            loadedModels = [];
                        }
                        populateModelDropdown(chatModelSelect, currentModelName);
                        populateModelDropdown(inspectorModelSelect, currentInspectorModelName);
                        
                        const herdSelects = document.querySelectorAll('.herd-model-select');
                        herdSelects.forEach((sel, idx) => {
                            const currentVal = herdParticipants[idx]?.model;
                            populateModelDropdown(sel, currentVal);
                        });

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
                    } else if (message.command === 'logData') {
                        const logEl = document.getElementById('logContent');
                        if (logEl) {
                            logEl.textContent = message.content || 'No log entries.';
                        }
                    }
                });

                refreshModelsList(false);
            });
          </script>
        </body>
        </html>`;
  }
}