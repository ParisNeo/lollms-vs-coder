import * as vscode from 'vscode';
import { LollmsAPI, LollmsConfig } from '../lollmsAPI';
import { Logger } from '../logger';
import { ProcessManager } from '../processManager';
import { PersonalityManager } from '../personalityManager';
import { HerdParticipant, DynamicModelEntry } from '../utils';

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
    architectModelName: '',
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
    noThinkMode: false,
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
    enableCodeActions: true,
    enableInlineSuggestions: false,
    mcpServers: '{}',
    herdParticipants: [] as HerdParticipant[],
    herdPreCodeParticipants: [] as HerdParticipant[],
    herdPostCodeParticipants: [] as HerdParticipant[],
    herdRounds: 2,
    herdDynamicMode: false,
    herdDynamicModelPool: [] as DynamicModelEntry[],
    // Git Config
    deleteBranchAfterMerge: true,
    unstagedChangesBehavior: 'stash'
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
    this._pendingConfig.architectModelName = config.get<string>('architectModelName') || '';
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
    this._pendingConfig.noThinkMode = config.get<boolean>('noThinkMode') || false;
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
    
    this._pendingConfig.enableCodeActions = config.get<boolean>('enableCodeActions') ?? true;
    this._pendingConfig.enableInlineSuggestions = config.get<boolean>('enableInlineSuggestions') ?? false;
    
    const mcpObj = config.get<object>('mcpServers') || {};
    this._pendingConfig.mcpServers = JSON.stringify(mcpObj, null, 2);

    this._pendingConfig.herdParticipants = config.get<HerdParticipant[]>('herdParticipants') || [];
    this._pendingConfig.herdPreCodeParticipants = config.get<HerdParticipant[]>('herdPreCodeParticipants') || [];
    this._pendingConfig.herdPostCodeParticipants = config.get<HerdParticipant[]>('herdPostCodeParticipants') || [];
    this._pendingConfig.herdRounds = config.get<number>('herdRounds') || 2;
    this._pendingConfig.herdDynamicMode = config.get<boolean>('herdDynamicMode') || false;
    this._pendingConfig.herdDynamicModelPool = config.get<DynamicModelEntry[]>('herdDynamicModelPool') || [];

    // Git
    this._pendingConfig.deleteBranchAfterMerge = config.get<boolean>('git.deleteBranchAfterMerge') ?? true;
    this._pendingConfig.unstagedChangesBehavior = config.get<string>('git.unstagedChangesBehavior') || 'stash';

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

                let parsedMcpServers = {};
                try {
                    parsedMcpServers = JSON.parse(this._pendingConfig.mcpServers || '{}');
                } catch (e) {
                    failures.push({ key: 'mcpServers', error: 'Invalid JSON for MCP Servers' });
                }

                const updates: [string, any][] = [
                  ['apiKey', this._pendingConfig.apiKey],
                  ['apiUrl', this._pendingConfig.apiUrl],
                  ['backendType', this._pendingConfig.backendType],
                  ['useLollmsExtensions', this._pendingConfig.useLollmsExtensions],
                  ['modelName', this._pendingConfig.modelName],
                  ['architectModelName', this._pendingConfig.architectModelName],
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
                  ['noThinkMode', this._pendingConfig.noThinkMode],
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
                  ['enableCodeActions', this._pendingConfig.enableCodeActions],
                  ['enableInlineSuggestions', this._pendingConfig.enableInlineSuggestions],
                  ['mcpServers', parsedMcpServers],
                  ['herdParticipants', this._pendingConfig.herdParticipants],
                  ['herdPreCodeParticipants', this._pendingConfig.herdPreCodeParticipants],
                  ['herdPostCodeParticipants', this._pendingConfig.herdPostCodeParticipants],
                  ['herdRounds', this._pendingConfig.herdRounds],
                  ['herdDynamicMode', this._pendingConfig.herdDynamicMode],
                  ['herdDynamicModelPool', this._pendingConfig.herdDynamicModelPool],
                  // New Git settings
                  ['git.deleteBranchAfterMerge', this._pendingConfig.deleteBranchAfterMerge],
                  ['git.unstagedChangesBehavior', this._pendingConfig.unstagedChangesBehavior]
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

            case 'resetConfig':
                const selection = await vscode.window.showWarningMessage(
                    "Are you sure you want to reset all Lollms configurations to factory defaults? This cannot be undone.",
                    { modal: true },
                    "Reset"
                );
                
                if (selection === "Reset") {
                    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                    // List of all configuration keys defined in package.json
                    const keys = [
                        'apiKey', 'apiUrl', 'backendType', 'useLollmsExtensions', 'modelName', 
                        'architectModelName', 'disableSslVerification', 'sslCertPath', 
                        'requestTimeout', 'agentMaxRetries', 'maxImageSize', 'enableCodeInspector',
                        'inspectorModelName', 'codeInspectorPersona', 'chatPersona', 'agentPersona',
                        'commitMessagePersona', 'contextFileExceptions', 'language', 'thinkingMode',
                        'noThinkMode', 'outputFormat', 'allowedFileFormats', 'thinkingModeCustomPrompt',
                        'reasoningLevel', 'failsafeContextSize', 'searchProvider', 'searchApiKey',
                        'searchCx', 'autoUpdateChangelog', 'autoGenerateTitle', 
                        'addPedagogicalInstruction', 'clipboardInsertRole', 'companion.enableWebSearch',
                        'companion.enableArxivSearch', 'userInfo.name', 'userInfo.email', 
                        'userInfo.license', 'userInfo.codingStyle', 'enableCodeActions', 
                        'enableInlineSuggestions', 'mcpServers', 'herdParticipants', 
                        'herdPreCodeParticipants', 'herdPostCodeParticipants', 'herdRounds', 
                        'herdDynamicMode', 'herdDynamicModelPool', 'git.deleteBranchAfterMerge',
                        'git.unstagedChangesBehavior'
                    ];
                    
                    try {
                        for (const key of keys) {
                            // Resetting to undefined removes the setting from settings.json, reverting to package.json default
                            await config.update(key, undefined, vscode.ConfigurationTarget.Global);
                            await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
                            await config.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
                        }
                        
                        vscode.window.showInformationMessage("Configuration reset to defaults. Please reopen settings.");
                        await vscode.commands.executeCommand('lollmsApi.recreateClient');
                        SettingsPanel.currentPanel?.dispose();
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to reset configuration: ${e.message}`);
                    }
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
    const { apiKey, apiUrl, backendType, useLollmsExtensions, modelName, architectModelName, disableSslVerification, sslCertPath, requestTimeout, agentMaxRetries, maxImageSize, enableCodeInspector, inspectorModelName, codeInspectorPersona, chatPersona, agentPersona, commitMessagePersona, contextFileExceptions, language, thinkingMode, noThinkMode, outputFormat, allowedFileFormats, thinkingModeCustomPrompt, reasoningLevel, failsafeContextSize, searchProvider, searchApiKey, searchCx, autoUpdateChangelog, autoGenerateTitle, addPedagogicalInstruction, clipboardInsertRole, companionEnableWebSearch, companionEnableArxivSearch, userInfoName, userInfoEmail, userInfoLicense, userInfoCodingStyle, enableCodeActions, enableInlineSuggestions, mcpServers, herdParticipants, herdPreCodeParticipants, herdPostCodeParticipants, herdRounds, herdDynamicMode, herdDynamicModelPool, deleteBranchAfterMerge, unstagedChangesBehavior } = config;

    const t = (key: string, def: string) => vscode.l10n.t({ message: def, key: key });
    
    const personalities = this._personalityManager.getPersonalities();
    const personalitiesJson = JSON.stringify(personalities)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/</g, '\\u003c');
    
    // Helper to serialize array
    const serialize = (arr: any) => JSON.stringify(arr).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\u003c');
    
    const herdDynamicModelPoolJson = serialize(herdDynamicModelPool);

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>${t('config.title', 'Lollms VS Coder Configuration')}</title>
            <link href="${webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'))}" rel="stylesheet" />
            <style>
              /* Copied styles from previous version + additions for herd lists */
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
              
              h1 { font-weight: 600; text-align: center; margin-bottom: 32px; font-size: 28px; }
              
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
                background: transparent; border: none; outline: none; cursor: pointer; padding: 10px 18px;
                color: var(--vscode-foreground); font-size: 13px; font-weight: 500; opacity: 0.7;
                border-radius: var(--border-radius-sm);
              }
              .tab-link:hover { opacity: 1; transform: translateY(-1px); }
              .tab-link.active { opacity: 1; color: white; font-weight: 600; background: linear-gradient(135deg, var(--primary-accent), var(--success-color)); }
              
              .tab-content { display: none; flex-grow: 1; overflow-y: auto; padding: 24px; background: var(--vscode-editor-background); border-radius: var(--border-radius); box-shadow: var(--shadow-sm); border: 1px solid var(--vscode-panel-border); }
              .tab-content.active { display: block; }
              
              h2 { font-weight: 600; font-size: 20px; border-bottom: 2px solid var(--primary-accent); padding-bottom: 12px; margin-top: 0; margin-bottom: 24px; color: var(--primary-accent); }
              h3 { font-size: 16px; margin-top: 28px; margin-bottom: 16px; font-weight: 600; color: var(--success-color); }
              
              label { display: block; margin-top: 18px; margin-bottom: 8px; font-weight: 600; font-size: 13px; color: var(--vscode-input-foreground); }
              input[type="text"], input[type="number"], textarea, select {
                width: 100%; padding: 10px 14px; border: 2px solid var(--vscode-input-border);
                border-radius: var(--border-radius-sm); background: var(--vscode-input-background);
                color: var(--vscode-input-foreground); font-size: 13px; box-sizing: border-box;
                font-family: inherit; transition: var(--transition);
              }
              input:focus, textarea:focus, select:focus { outline: none; border-color: var(--primary-accent); }
              textarea { resize: vertical; min-height: 100px; font-family: 'Consolas', monospace; }
              
              button {
                background: linear-gradient(135deg, var(--primary-accent), color-mix(in srgb, var(--primary-accent) 85%, var(--success-color)));
                color: white; border: none; padding: 12px 24px; font-size: 14px; font-weight: 600; border-radius: var(--border-radius-sm); cursor: pointer; transition: var(--transition);
              }
              button.save-btn { margin-top: 32px; width: 100%; padding: 14px; font-size: 15px; }
              button:hover { transform: translateY(-2px); }
              
              button.reset-btn {
                background: var(--error-color); 
                margin-top: 16px; width: 100%; padding: 10px; font-size: 13px; opacity: 0.9;
              }
              button.reset-btn:hover { background: color-mix(in srgb, var(--error-color) 85%, black); opacity: 1; }

              .secondary-button { margin-top: 12px; padding: 8px 16px; font-size: 13px; width: auto; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
              .icon-btn { width: auto; padding: 10px 14px; margin-top: 0; min-width: 44px; }
              
              .checkbox-container { display: flex; align-items: center; margin-top: 14px; padding: 12px; background: var(--vscode-editorWidget-background); border-radius: var(--border-radius-sm); border: 1px solid transparent; }
              .checkbox-container input { margin-right: 10px; width: 18px; height: 18px; cursor: pointer; }
              .checkbox-container label { margin: 0; cursor: pointer; }
              
              .input-group { display: flex; gap: 8px; }
              .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 12px; }
              
              .participant-row { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; background: var(--vscode-editorWidget-background); padding: 14px; border-radius: var(--border-radius-sm); border: 2px solid var(--vscode-widget-border); }
              .participant-row select, .participant-row input { flex: 1; }
              .remove-btn { width: auto; background: var(--error-color); padding: 8px 14px; }
              .remove-btn:hover { background: color-mix(in srgb, var(--error-color) 85%, black); }
              
              .help-text { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 6px; font-style: italic; }
              .persona-selector-row { display: flex; justify-content: space-between; align-items: center; margin: 8px 0; padding: 8px 12px; background: var(--vscode-editorWidget-background); border-radius: var(--border-radius-sm); }
              .persona-selector-row select { width: 60%; font-size: 12px; padding: 6px 10px; }
            </style>
        </head>
        <body>
          <div class="container">
            <h1>⚙️  ${t('config.title', 'Lollms VS Coder Configuration')}</h1>
          
            <div class="tabs">
              <button class="tab-link active" onclick="openTab(event, 'TabApi')">🔌 API & Model</button>
              <button class="tab-link" onclick="openTab(event, 'TabGeneral')">⚡ General</button>
              <button class="tab-link" onclick="openTab(event, 'TabContext')">📦 Context</button>
              <button class="tab-link" onclick="openTab(event, 'TabAgent')">🤖 Agent & Tools</button>
              <button class="tab-link" onclick="openTab(event, 'TabGit')">🐙 Git</button>
              <button class="tab-link" onclick="openTab(event, 'TabHerd')">🐂 Herd Mode</button>
              <button class="tab-link" onclick="openTab(event, 'TabPersonas')">🎭­ Personas</button>
              <button class="tab-link" onclick="openTab(event, 'TabUser')">👤 User Info</button>
              <button class="tab-link" onclick="openTab(event, 'TabLog')">📋 Log</button>
            </div>

            <!-- TabApi Content -->
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

              <label for="architectModelSelect">Architect/Planner Model (Agent Mode)</label>
              <div class="input-group">
                  <select id="architectModelSelect" class="model-dropdown"></select>
              </div>
              <span class="help-text">Used for planning complex tasks. Defaults to Chat Model if empty.</span>
              
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

            <!-- TabGeneral -->
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
              <div class="grid-2">
                  <div class="checkbox-container"><input type="checkbox" id="fmt-fullFile" ${allowedFileFormats.fullFile ? 'checked' : ''}><label for="fmt-fullFile">Full File</label></div>
                  <div class="checkbox-container"><input type="checkbox" id="fmt-insert" ${allowedFileFormats.insert ? 'checked' : ''}><label for="fmt-insert">Insert</label></div>
                  <div class="checkbox-container"><input type="checkbox" id="fmt-replace" ${allowedFileFormats.replace ? 'checked' : ''}><label for="fmt-replace">Replace</label></div>
                  <div class="checkbox-container"><input type="checkbox" id="fmt-delete" ${allowedFileFormats.delete ? 'checked' : ''}><label for="fmt-delete">Delete</label></div>
              </div>

              <h3>Editor Integration</h3>
              <div class="checkbox-container"><input type="checkbox" id="enableCodeActions" ${enableCodeActions ? 'checked' : ''}><label for="enableCodeActions">Enable Lollms Code Actions (CodeLens)</label></div>
              <div class="checkbox-container"><input type="checkbox" id="enableInlineSuggestions" ${enableInlineSuggestions ? 'checked' : ''}><label for="enableInlineSuggestions">Enable Inline Ghost Text Suggestions</label></div>

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

              <div class="checkbox-container"><input type="checkbox" id="noThinkMode" ${noThinkMode ? 'checked' : ''}><label for="noThinkMode">Enable /no_think Mode (Global Override)</label></div>
              <div class="checkbox-container"><input type="checkbox" id="autoGenerateTitle" ${autoGenerateTitle ? 'checked' : ''}><label for="autoGenerateTitle">Auto-generate discussion titles</label></div>
              <div class="checkbox-container"><input type="checkbox" id="addPedagogicalInstruction" ${addPedagogicalInstruction ? 'checked' : ''}><label for="addPedagogicalInstruction">Add Pedagogical Instruction (Hidden)</label></div>
            </div>

            <!-- TabContext -->
            <div id="TabContext" class="tab-content">
              <h2>${t('config.section.contextAndFile', 'Context & File Strategy')}</h2>
              <label for="failsafeContextSize">${t('config.failsafeContextSize.label', 'Failsafe Context Size')}</label>
              <input type="number" id="failsafeContextSize" value="${failsafeContextSize}" min="1024" step="1024" />
              <label for="maxImageSize">${t('config.maxImageSize.label', 'Max Image Size (px)')}</label>
              <input type="number" id="maxImageSize" value="${maxImageSize}" min="0" step="128" />
              <label for="contextFileExceptions">${t('config.contextFileExceptions.label', 'Context File Exceptions')}</label>
              <textarea id="contextFileExceptions" rows="8">${contextFileExceptions.join('\n')}</textarea>
            </div>

            <!-- TabAgent -->
            <div id="TabAgent" class="tab-content">
              <h2>${t('config.section.agentAndInspector', 'Agent & Tools')}</h2>
              <label for="agentMaxRetries">${t('config.agentMaxRetries.label', 'Agent Self-Correction Retries')}</label>
              <input type="number" id="agentMaxRetries" value="${agentMaxRetries}" min="0" max="5" />
              <div class="checkbox-container"><input type="checkbox" id="enableCodeInspector" ${enableCodeInspector ? 'checked' : ''}><label for="enableCodeInspector">${t('config.enableCodeInspector.label', 'Enable Code Inspector')}</label></div>
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
              
              <h3>Companion</h3>
              <div class="checkbox-container"><input type="checkbox" id="companionEnableWebSearch" ${companionEnableWebSearch ? 'checked' : ''}><label for="companionEnableWebSearch">Enable Web Search in Companion</label></div>
              <div class="checkbox-container"><input type="checkbox" id="companionEnableArxivSearch" ${companionEnableArxivSearch ? 'checked' : ''}><label for="companionEnableArxivSearch">Enable ArXiv Search in Companion</label></div>

              <h3>MCP Servers Configuration</h3>
              <label for="mcpServers">MCP Servers (JSON)</label>
              <textarea id="mcpServers" rows="6" placeholder='{"server-name": "command arg1 arg2"}' style="font-family: monospace;">${mcpServers}</textarea>
              <span class="help-text">Format: {"serverName": "command args"}</span>
            </div>

            <!-- TabGit -->
            <div id="TabGit" class="tab-content">
              <h2>Git Integration</h2>
              <div class="checkbox-container"><input type="checkbox" id="autoUpdateChangelog" ${autoUpdateChangelog ? 'checked' : ''}><label for="autoUpdateChangelog">Auto-update CHANGELOG.md</label></div>
              <div class="checkbox-container"><input type="checkbox" id="deleteBranchAfterMerge" ${deleteBranchAfterMerge ? 'checked' : ''}><label for="deleteBranchAfterMerge">Auto-delete temporary branch after merge</label></div>
              
              <label for="unstagedChangesBehavior">Action for unstaged changes before new AI branch:</label>
              <select id="unstagedChangesBehavior">
                  <option value="stash" ${unstagedChangesBehavior === 'stash' ? 'selected' : ''}>Stash Changes</option>
                  <option value="keep" ${unstagedChangesBehavior === 'keep' ? 'selected' : ''}>Keep (Carry Over)</option>
                  <option value="error" ${unstagedChangesBehavior === 'error' ? 'selected' : ''}>Show Error (Stop)</option>
              </select>

              <label for="commitMessagePersona">${t('config.commitMessagePersona.label', 'Git Commit Persona')}</label>
              <div class="persona-selector-row"><span class="help-text">Preset:</span><select class="persona-select" data-target="commitMessagePersona"></select></div>
              <textarea id="commitMessagePersona" rows="4">${commitMessagePersona}</textarea>
            </div>

            <!-- TabHerd -->
            <div id="TabHerd" class="tab-content">
              <h2>Herd Mode 🐂</h2>

              <p class="help-text">Configure multi-model brainstorming sessions.</p>

              <div class="checkbox-container">
                  <input type="checkbox" id="herdDynamicMode" ${herdDynamicMode ? 'checked' : ''}>
                  <label for="herdDynamicMode">Dynamic Herd Mode (AI builds the team for you)</label>
              </div>
              
              <label for="herdRounds">Number of Rounds</label>
              <input type="number" id="herdRounds" value="${herdRounds}" min="1" max="10" />

              <div id="static-herd-config" style="display: ${herdDynamicMode ? 'none' : 'block'};">
                  <h3>Phase 1: Pre-Code Brainstorming Agents</h3>
                  <div id="herd-pre-list"></div>
                  <button id="addPreParticipantBtn" class="secondary-button"><i class="codicon codicon-add"></i> Add Pre-Code Agent</button>

                  <h3>Phase 3: Post-Code Review Agents</h3>
                  <div id="herd-post-list"></div>
                  <button id="addPostParticipantBtn" class="secondary-button"><i class="codicon codicon-add"></i> Add Post-Code Agent</button>
              </div>

              <div id="dynamic-herd-config" style="display: ${herdDynamicMode ? 'block' : 'none'};">
                  <h3>Dynamic Model Pool</h3>
                  <p class="help-text">Define models available for the AI to choose from when building a team.</p>
                  <div id="herd-pool-list"></div>
                  <button id="addPoolModelBtn" class="secondary-button"><i class="codicon codicon-add"></i> Add Model to Pool</button>
              </div>
            </div>

            <!-- TabPersonas -->
            <div id="TabPersonas" class="tab-content">
              <h2>${t('config.section.personas', 'Personas / System Prompts')}</h2>
              <button id="createPersonalityBtn" class="secondary-button" style="margin-bottom: 15px;"><i class="codicon codicon-add"></i> Create New Personality</button>
              <label for="chatPersona">${t('config.chatPersona.label', 'Chat Mode Persona')}</label>
              <div class="persona-selector-row"><span class="help-text">Preset:</span><select class="persona-select" data-target="chatPersona"></select></div>
              <textarea id="chatPersona" rows="4">${chatPersona}</textarea>
              <label for="agentPersona">${t('config.agentPersona.label', 'Agent Mode Persona')}</label>
              <div class="persona-selector-row"><span class="help-text">Preset:</span><select class="persona-select" data-target="agentPersona"></select></div>
              <textarea id="agentPersona" rows="4">${agentPersona}</textarea>
              <label for="codeInspectorPersona">${t('config.codeInspectorPersona.label', 'Code Inspector Persona')}</label>
              <div class="persona-selector-row"><span class="help-text">Preset:</span><select class="persona-select" data-target="codeInspectorPersona"></select></div>
              <textarea id="codeInspectorPersona" rows="4">${codeInspectorPersona}</textarea>
              
              <div style="margin-top: 24px; border-top: 1px solid var(--primary-accent); padding-top: 12px;">
                  <button id="editPromptsBtn" class="secondary-button">${t('command.editPromptsFile.title', 'Edit Prompts JSON File')}</button>
              </div>
            </div>

            <!-- TabUser -->
            <div id="TabUser" class="tab-content">
              <h2>User Information</h2>
              <label for="userInfoName">Full Name</label>
              <input type="text" id="userInfoName" value="${userInfoName}" />
              <label for="userInfoEmail">Email</label>
              <input type="text" id="userInfoEmail" value="${userInfoEmail}" />
              <label for="userInfoLicense">Default License</label>
              <input type="text" id="userInfoLicense" value="${userInfoLicense}" />
              <label for="userInfoCodingStyle">Coding Style</label>
              <textarea id="userInfoCodingStyle" rows="3">${userInfoCodingStyle}</textarea>
            </div>

            <!-- TabLog -->
            <div id="TabLog" class="tab-content">
              <h2>Log</h2>
              <div class="log-container"><pre id="logContent"></pre></div>
            </div>

            <button id="saveConfig" class="save-btn">${t('config.saveAndClose', 'Save & Close')}</button>
            <button id="resetConfig" class="reset-btn">Reset to Factory Defaults</button>
          </div>
        
          <script>
            const vscode = acquireVsCodeApi();
            const currentModelName = "${modelName}";
            const currentArchitectModelName = "${architectModelName}";
            const currentInspectorModelName = "${inspectorModelName}";
            
            let personalities = [];
            try { personalities = JSON.parse('${personalitiesJson}'); } catch (e) {}

            let herdPre = [];
            try { herdPre = JSON.parse('${serialize(herdPreCodeParticipants)}'); } catch (e) {}
            
            let herdPost = [];
            try { herdPost = JSON.parse('${serialize(herdPostCodeParticipants)}'); } catch (e) {}

            let herdPool = [];
            try { herdPool = JSON.parse('${herdDynamicModelPoolJson}'); } catch (e) {}

            let loadedModels = [];

            function openTab(evt, tabName) {
                var i, tabcontent, tablinks;
                tabcontent = document.getElementsByClassName("tab-content");
                for (i = 0; i < tabcontent.length; i++) { tabcontent[i].style.display = "none"; tabcontent[i].classList.remove("active"); }
                tablinks = document.getElementsByClassName("tab-link");
                for (i = 0; i < tablinks.length; i++) { tablinks[i].className = tablinks[i].className.replace(" active", ""); }
                document.getElementById(tabName).style.display = "block";
                document.getElementById(tabName).classList.add("active");
                evt.currentTarget.className += " active";
                if (tabName === 'TabLog') vscode.postMessage({ command: 'requestLog' });
            }

            function populateModelDropdown(selectElement, selectedValue) {
                selectElement.innerHTML = '';
                if (loadedModels.length > 0) {
                    if (selectElement.id === 'inspectorModelName' || selectElement.id === 'architectModelSelect') {
                        selectElement.appendChild(new Option("Same as Chat Model (Default)", ""));
                    }
                    loadedModels.forEach(model => selectElement.appendChild(new Option(model.id, model.id)));
                    if (selectedValue) selectElement.value = selectedValue;
                } else {
                    selectElement.appendChild(new Option(selectedValue || "Loading...", selectedValue));
                }
            }

            function renderParticipantsList(containerId, list, keyName) {
                const container = document.getElementById(containerId);
                container.innerHTML = '';
                list.forEach((p, index) => {
                    const row = document.createElement('div');
                    row.className = 'participant-row';
                    
                    const modelSelect = document.createElement('select');
                    modelSelect.className = 'herd-model-select';
                    populateModelDropdown(modelSelect, p.model);
                    modelSelect.onchange = (e) => {
                        list[index].model = e.target.value;
                        postTempUpdate(keyName, list);
                    };

                    const personaSelect = document.createElement('select');
                    personalities.forEach(person => personaSelect.appendChild(new Option(person.name, person.id)));
                    personaSelect.value = p.personality;
                    personaSelect.onchange = (e) => {
                        list[index].personality = e.target.value;
                        postTempUpdate(keyName, list);
                    };

                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'remove-btn icon-btn';
                    removeBtn.innerHTML = '<i class="codicon codicon-trash"></i>';
                    removeBtn.onclick = () => {
                        list.splice(index, 1);
                        renderParticipantsList(containerId, list, keyName);
                        postTempUpdate(keyName, list);
                    };

                    row.appendChild(modelSelect);
                    row.appendChild(personaSelect);
                    row.appendChild(removeBtn);
                    container.appendChild(row);
                });
            }

            function renderPoolList() {
                const container = document.getElementById('herd-pool-list');
                container.innerHTML = '';
                herdPool.forEach((item, index) => {
                    const row = document.createElement('div');
                    row.className = 'participant-row';

                    const modelSelect = document.createElement('select');
                    modelSelect.className = 'herd-model-select';
                    populateModelDropdown(modelSelect, item.model);
                    modelSelect.onchange = (e) => {
                        herdPool[index].model = e.target.value;
                        postTempUpdate('herdDynamicModelPool', herdPool);
                    };

                    const descInput = document.createElement('input');
                    descInput.type = 'text';
                    descInput.placeholder = 'Description (e.g. "Fast reasoning")';
                    descInput.value = item.description || '';
                    descInput.oninput = (e) => {
                        herdPool[index].description = e.target.value;
                        postTempUpdate('herdDynamicModelPool', herdPool);
                    };

                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'remove-btn icon-btn';
                    removeBtn.innerHTML = '<i class="codicon codicon-trash"></i>';
                    removeBtn.onclick = () => {
                        herdPool.splice(index, 1);
                        renderPoolList();
                        postTempUpdate('herdDynamicModelPool', herdPool);
                    };

                    row.appendChild(modelSelect);
                    row.appendChild(descInput);
                    row.appendChild(removeBtn);
                    container.appendChild(row);
                });
            }

            window.addEventListener('DOMContentLoaded', () => {
                openTab({ currentTarget: document.querySelector('.tab-link.active') }, 'TabApi');

                const bind = (id, key) => {
                    const el = document.getElementById(id);
                    if(!el) return;
                    el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
                        let val = el.type === 'checkbox' ? el.checked : el.value;
                        if(el.type === 'number') val = parseInt(val);
                        if(key === 'contextFileExceptions') val = val.split('\\n').map(s=>s.trim()).filter(Boolean);
                        postTempUpdate(key, val);
                    });
                };
                
                ['apiKey','apiUrl','backendType','useLollmsExtensions','requestTimeout','agentMaxRetries','maxImageSize','inspectorModelName','codeInspectorPersona','chatPersona','agentPersona','commitMessagePersona','language','thinkingMode','outputFormat','thinkingModeCustomPrompt','reasoningLevel','failsafeContextSize','userInfoName','userInfoEmail','userInfoLicense','userInfoCodingStyle','searchApiKey','searchCx','clipboardInsertRole','herdRounds','mcpServers','unstagedChangesBehavior'].forEach(k => bind(k, k));
                ['disableSsl','enableCodeInspector','autoUpdateChangelog','autoGenerateTitle','addPedagogicalInstruction','companionEnableWebSearch','companionEnableArxivSearch','herdDynamicMode','enableCodeActions','enableInlineSuggestions','noThinkMode','deleteBranchAfterMerge'].forEach(id => {
                    const map = { 'disableSsl': 'disableSslVerification', 'deleteBranchAfterMerge': 'git.deleteBranchAfterMerge' };
                    const key = map[id] || id; 
                    if(id==='companionEnableWebSearch') bind(id, 'companion.enableWebSearch');
                    else if(id==='companionEnableArxivSearch') bind(id, 'companion.enableArxivSearch');
                    else if(id==='disableSsl') bind(id, 'disableSslVerification');
                    else if(id==='deleteBranchAfterMerge') bind(id, 'git.deleteBranchAfterMerge');
                    else bind(id, id);
                });
                // Special mapping for unstagedChangesBehavior which has a '.'
                document.getElementById('unstagedChangesBehavior').addEventListener('change', (e) => {
                    postTempUpdate('git.unstagedChangesBehavior', e.target.value);
                });

                ['fullFile','insert','replace','delete'].forEach(k => {
                    document.getElementById('fmt-'+k).addEventListener('change', (e) => {
                        vscode.postMessage({ command: 'updateFormatValue', key: k, value: e.target.checked });
                    });
                });

                const chatModelSelect = document.getElementById('modelSelect');
                const inspectorModelSelect = document.getElementById('inspectorModelName');
                const architectModelSelect = document.getElementById('architectModelSelect');
                
                chatModelSelect.addEventListener('change', () => postTempUpdate('modelName', chatModelSelect.value));
                inspectorModelSelect.addEventListener('change', () => postTempUpdate('inspectorModelName', inspectorModelSelect.value));
                architectModelSelect.addEventListener('change', () => postTempUpdate('architectModelName', architectModelSelect.value));

                // Herd Dynamic Toggle UI logic
                const herdDynamicCheckbox = document.getElementById('herdDynamicMode');
                const staticConfig = document.getElementById('static-herd-config');
                const dynamicConfig = document.getElementById('dynamic-herd-config');
                
                herdDynamicCheckbox.addEventListener('change', () => {
                     const isDynamic = herdDynamicCheckbox.checked;
                     staticConfig.style.display = isDynamic ? 'none' : 'block';
                     dynamicConfig.style.display = isDynamic ? 'block' : 'none';
                });

                document.getElementById('addPreParticipantBtn').addEventListener('click', () => {
                    herdPre.push({ model: currentModelName, personality: 'default_coder' });
                    renderParticipantsList('herd-pre-list', herdPre, 'herdPreCodeParticipants');
                    postTempUpdate('herdPreCodeParticipants', herdPre);
                });
                document.getElementById('addPostParticipantBtn').addEventListener('click', () => {
                    herdPost.push({ model: currentModelName, personality: 'code_reviewer' });
                    renderParticipantsList('herd-post-list', herdPost, 'herdPostCodeParticipants');
                    postTempUpdate('herdPostCodeParticipants', herdPost);
                });
                
                document.getElementById('addPoolModelBtn').addEventListener('click', () => {
                    herdPool.push({ model: currentModelName, description: 'General purpose model' });
                    renderPoolList();
                    postTempUpdate('herdDynamicModelPool', herdPool);
                });

                document.getElementById('refreshModels').addEventListener('click', () => refreshModelsList(true));
                document.getElementById('refreshInspectorModels').addEventListener('click', () => refreshModelsList(true));
                document.getElementById('saveConfig').addEventListener('click', () => vscode.postMessage({ command: 'saveConfig' }));
                document.getElementById('resetConfig').addEventListener('click', () => vscode.postMessage({ command: 'resetConfig' }));
                document.getElementById('testConnection').addEventListener('click', () => vscode.postMessage({ command: 'testConnection' }));
                document.getElementById('browseCertPath').addEventListener('click', () => vscode.postMessage({ command: 'browseCertPath' }));
                document.getElementById('createPersonalityBtn').addEventListener('click', () => vscode.postMessage({ command: 'createPersonality' }));
                document.getElementById('editPromptsBtn').addEventListener('click', () => vscode.postMessage({ command: 'editPrompts' }));

                function postTempUpdate(key, value) { vscode.postMessage({ command: 'updateTempValue', key, value }); }
                
                function refreshModelsList(force) {
                    chatModelSelect.innerHTML = '<option>Loading...</option>';
                    inspectorModelSelect.innerHTML = '<option>Loading...</option>';
                    architectModelSelect.innerHTML = '<option>Loading...</option>';
                    vscode.postMessage({ command: 'fetchModels', value: force });
                }

                renderParticipantsList('herd-pre-list', herdPre, 'herdPreCodeParticipants');
                renderParticipantsList('herd-post-list', herdPost, 'herdPostCodeParticipants');
                renderPoolList();
                refreshModelsList(false);

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'modelsList') {
                        loadedModels = message.models || [];
                        populateModelDropdown(chatModelSelect, currentModelName);
                        populateModelDropdown(inspectorModelSelect, currentInspectorModelName);
                        populateModelDropdown(architectModelSelect, currentArchitectModelName);
                        
                        // Refresh all dropdowns
                        renderParticipantsList('herd-pre-list', herdPre, 'herdPreCodeParticipants');
                        renderParticipantsList('herd-post-list', herdPost, 'herdPostCodeParticipants');
                        renderPoolList();
                    } else if (message.command === 'updateCertPath') {
                        document.getElementById('sslCertPath').value = message.path;
                        postTempUpdate('sslCertPath', message.path);
                    } else if (message.command === 'updatePersonalities') {
                        personalities = message.personalities;
                        renderParticipantsList('herd-pre-list', herdPre, 'herdPreCodeParticipants');
                        renderParticipantsList('herd-post-list', herdPost, 'herdPostCodeParticipants');
                        // Update persona selects in static UI
                        document.querySelectorAll('.persona-select').forEach(sel => {
                            const val = sel.value;
                            sel.innerHTML = '<option value="">-- Select a Preset --</option>';
                            personalities.forEach(p => sel.appendChild(new Option(p.name, p.id)));
                            sel.value = val;
                        });
                    } else if (message.command === 'logData') {
                        document.getElementById('logContent').textContent = message.content || 'No log data.';
                    }
                });
            });
          </script>
        </body>
        </html>`;
  }
}
