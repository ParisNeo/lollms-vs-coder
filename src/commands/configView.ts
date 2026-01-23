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
    agentPermissions: {
        shellExecution: true,
        filesystemWrite: true,
        filesystemRead: true,
        internetAccess: true
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
    deleteBranchAfterMerge: true,
    unstagedChangesBehavior: 'stash',
    showOs: true,
    showIp: false,
    showShells: true,
    systemCustomInfo: ''
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

    this._pendingConfig.agentPermissions = config.get<any>('agent.permissions') || {
        shellExecution: true,
        filesystemWrite: true,
        filesystemRead: true,
        internetAccess: true
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

    this._pendingConfig.deleteBranchAfterMerge = config.get<boolean>('git.deleteBranchAfterMerge') ?? true;
    this._pendingConfig.unstagedChangesBehavior = config.get<string>('git.unstagedChangesBehavior') || 'stash';

    this._pendingConfig.showOs = config.get<boolean>('systemEnv.showOs') ?? true;
    this._pendingConfig.showIp = config.get<boolean>('systemEnv.showIp') ?? false;
    this._pendingConfig.showShells = config.get<boolean>('systemEnv.showShells') ?? true;
    this._pendingConfig.systemCustomInfo = config.get<string>('systemEnv.customInfo') || '';

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
            case 'close':
              this.dispose();
              return;

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

            case 'updatePermissionValue':
              if (message.key) {
                  (this._pendingConfig.agentPermissions as any)[message.key] = message.value;
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
                const target = vscode.ConfigurationTarget.Global;
                const failures: { key: string; error: string }[] = [];

                const safeUpdate = async (key: string, value: any) => {
                  try {
                    Logger.debug(`Updating config key '${key}'`, value);
                    await config.update(key, value, target);
                  } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : String(e);
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
                  ['agent.permissions', this._pendingConfig.agentPermissions],
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
                  ['git.deleteBranchAfterMerge', this._pendingConfig.deleteBranchAfterMerge],
                  ['git.unstagedChangesBehavior', this._pendingConfig.unstagedChangesBehavior],
                  ['systemEnv.showOs', this._pendingConfig.showOs],
                  ['systemEnv.showIp', this._pendingConfig.showIp],
                  ['systemEnv.showShells', this._pendingConfig.showShells],
                  ['systemEnv.customInfo', this._pendingConfig.systemCustomInfo]
                ];

                for (const [key, value] of updates) {
                  await safeUpdate(key, value);
                }

                if (failures.length === 0) {
                  vscode.window.showInformationMessage(
                    vscode.l10n.t({ key: 'info.configSaved', message: 'Configuration saved. Recreating LollmsAPI...' })
                  );
                  await vscode.commands.executeCommand('lollmsApi.recreateClient');
                  SettingsPanel.currentPanel?.dispose();
                } else {
                  const errorDetails = failures.map(f => `  • ${f.key}: ${f.error}`).join('\n');
                  vscode.window.showErrorMessage(`Configuration saved with errors:\n\n${errorDetails}`, { modal: true });
                }
              } catch (err) {
                vscode.window.showErrorMessage('Failed to save configuration.');
              }
              return;

            case 'resetConfig':
                const selection = await vscode.window.showWarningMessage(
                    "Are you sure you want to reset all Lollms configurations to factory defaults?",
                    { modal: true }, "Reset"
                );
                if (selection === "Reset") {
                    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                    const keys = [
                        'apiKey', 'apiUrl', 'backendType', 'useLollmsExtensions', 'modelName', 
                        'architectModelName', 'disableSslVerification', 'sslCertPath', 
                        'requestTimeout', 'agentMaxRetries', 'maxImageSize', 'enableCodeInspector',
                        'inspectorModelName', 'codeInspectorPersona', 'chatPersona', 'agentPersona',
                        'commitMessagePersona', 'contextFileExceptions', 'language', 'thinkingMode',
                        'noThinkMode', 'outputFormat', 'allowedFileFormats', 'agent.permissions',
                        'thinkingModeCustomPrompt', 'reasoningLevel', 'failsafeContextSize', 
                        'searchProvider', 'searchApiKey', 'searchCx', 'autoUpdateChangelog', 
                        'autoGenerateTitle', 'addPedagogicalInstruction', 'clipboardInsertRole', 
                        'companion.enableWebSearch', 'companion.enableArxivSearch', 'userInfo.name', 
                        'userInfo.email', 'userInfo.license', 'userInfo.codingStyle', 'enableCodeActions', 
                        'enableInlineSuggestions', 'mcpServers', 'herdParticipants', 
                        'herdPreCodeParticipants', 'herdPostCodeParticipants', 'herdRounds', 
                        'herdDynamicMode', 'herdDynamicModelPool', 'git.deleteBranchAfterMerge',
                        'git.unstagedChangesBehavior', 'systemEnv.showOs', 'systemEnv.showIp', 
                        'systemEnv.showShells', 'systemEnv.customInfo'
                    ];
                    try {
                        for (const key of keys) {
                            await config.update(key, undefined, vscode.ConfigurationTarget.Global);
                        }
                        vscode.window.showInformationMessage("Configuration reset.");
                        await vscode.commands.executeCommand('lollmsApi.recreateClient');
                        SettingsPanel.currentPanel?.dispose();
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to reset: ${e.message}`);
                    }
                }
                return;
  
            case 'fetchModels':
              if (this._panel) {
                const processId = 'settings-fetch-models';
                const { id, controller } = this._processManager.register(processId, 'Settings: Fetching Models');
                try {
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
                this._panel.webview.postMessage({ command: 'logData', content: logContent });
                return;
          }
        },
        undefined,
        []
      );
  }

  private _getHtml(webview: vscode.Webview, config: any) {
    const { apiKey, apiUrl, backendType, useLollmsExtensions, modelName, architectModelName, disableSslVerification, sslCertPath, requestTimeout, agentMaxRetries, maxImageSize, enableCodeInspector, inspectorModelName, codeInspectorPersona, chatPersona, agentPersona, commitMessagePersona, contextFileExceptions, language, thinkingMode, noThinkMode, outputFormat, allowedFileFormats, agentPermissions, thinkingModeCustomPrompt, reasoningLevel, failsafeContextSize, searchProvider, searchApiKey, searchCx, autoUpdateChangelog, autoGenerateTitle, addPedagogicalInstruction, userInfoName, userInfoEmail, userInfoLicense, userInfoCodingStyle, enableCodeActions, enableInlineSuggestions, mcpServers, herdParticipants, herdPreCodeParticipants, herdPostCodeParticipants, herdRounds, herdDynamicMode, herdDynamicModelPool, showOs, showIp, showShells, systemCustomInfo } = config;

    const t = (key: string, def: string) => vscode.l10n.t({ message: def, key: key });

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
                --transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
              }
              body, html {
                height: 100%; width:100%; margin: 0; padding: 0;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-size: 13px;
                line-height: 1.6;
              }
              .container { 
                padding: 16px 24px; 
                height: 100%; 
                box-sizing: border-box; 
                display: flex; 
                flex-direction: column; 
                max-width: 1400px; /* INCREASED WIDTH */
                margin: 0 auto; 
              }

              /* TOOLBAR HEADER */
              .header-toolbar {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
                border-bottom: 1px solid var(--vscode-panel-border);
                padding-bottom: 12px;
              }
              .title-group { display: flex; align-items: center; gap: 10px; }
              .title-group i { font-size: 18px; color: var(--primary-accent); }
              h1 { font-weight: 600; margin: 0; font-size: 18px; } /* REDUCED SIZE */

              .toolbar-actions { display: flex; gap: 8px; }
              .toolbar-btn {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: 1px solid var(--vscode-widget-border);
                padding: 4px 10px;
                border-radius: 4px;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 12px;
                font-weight: 500;
                transition: var(--transition);
              }
              .toolbar-btn:hover { background: var(--vscode-button-secondaryHoverBackground); transform: translateY(-1px); }
              .toolbar-btn.primary { background: var(--primary-accent); color: white; border: none; }
              .toolbar-btn.primary:hover { background: var(--primary-accent-hover); }
              .toolbar-btn.danger { color: var(--error-color); }
              .toolbar-btn svg { width: 14px; height: 14px; fill: currentColor; }

              .tabs { display: flex; background: var(--vscode-editorWidget-background); border-radius: var(--border-radius-sm); padding: 4px; margin-bottom: 20px; flex-wrap: wrap; gap: 4px; border: 1px solid var(--vscode-panel-border); }
              .tab-link { background: transparent; border: none; outline: none; cursor: pointer; padding: 6px 12px; color: var(--vscode-foreground); font-size: 12px; font-weight: 500; opacity: 0.7; border-radius: var(--border-radius-sm); }
              .tab-link:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
              .tab-link.active { opacity: 1; color: white; background: var(--primary-accent); }
              
              .tab-content { display: none; flex-grow: 1; overflow-y: auto; padding: 20px; background: var(--vscode-editor-background); border-radius: var(--border-radius-sm); border: 1px solid var(--vscode-panel-border); }
              .tab-content.active { display: block; }
              
              h2 { font-weight: 600; font-size: 16px; margin-top: 0; margin-bottom: 20px; color: var(--primary-accent); display: flex; align-items: center; gap: 8px; }
              h3 { font-size: 14px; margin-top: 24px; margin-bottom: 12px; font-weight: 600; color: var(--success-color); }
              
              label { display: block; margin-top: 14px; margin-bottom: 6px; font-weight: 600; opacity: 0.9; }
              input[type="text"], input[type="number"], textarea, select { width: 100%; padding: 8px 12px; border: 1px solid var(--vscode-input-border); border-radius: var(--border-radius-sm); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-size: 12px; box-sizing: border-box; font-family: inherit; }
              .checkbox-container { display: flex; align-items: center; margin-top: 10px; padding: 8px 12px; background: var(--vscode-editorWidget-background); border-radius: var(--border-radius-sm); border: 1px solid var(--vscode-panel-border); }
              .checkbox-container input { margin-right: 10px; width: 16px; height: 16px; cursor: pointer; }
              .input-group { display: flex; gap: 4px; }
              .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; margin-top: 10px; }
              .help-text { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; font-style: italic; }
              
              .icon-btn { padding: 4px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-widget-border); border-radius: 4px; cursor: pointer; display: flex; align-items: center; }
              .icon-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

              /* LOG AREA */
              #logContent { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; font-family: monospace; font-size: 11px; overflow-x: auto; border: 1px solid var(--vscode-panel-border); }
            </style>
        </head>
        <body>
          <div class="container">
            <header class="header-toolbar">
              <div class="title-group">
                <i class="codicon codicon-settings-gear"></i>
                <h1>Lollms Configuration</h1>
              </div>
              <div class="toolbar-actions">
                <button class="toolbar-btn primary" id="saveTop" title="Save All Settings">
                  <svg viewBox="0 0 24 24"><path d="M17,3H5C3.89,3 3,3.9 3,5V19C3,20.1 3.89,21 5,21H19C20.1,21 21,20.1 21,19V7L17,3M12,19A3,3 0 0,1 9,16A3,3 0 0,1 12,13A3,3 0 0,1 15,16A3,3 0 0,1 12,19M15,9H5V5H15V9Z"/></svg>
                  Save
                </button>
                <button class="toolbar-btn danger" id="resetTop" title="Reset to Defaults">
                  <svg viewBox="0 0 24 24"><path d="M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z"/></svg>
                  Reset
                </button>
                <button class="toolbar-btn" id="closeTop" title="Close Settings">
                  <svg viewBox="0 0 24 24"><path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/></svg>
                  Close
                </button>
              </div>
            </header>

            <div class="tabs">
              <button class="tab-link active" onclick="openTab(event, 'TabApi')">🔌 API & Model</button>
              <button class="tab-link" onclick="openTab(event, 'TabGeneral')">⚡ General</button>
              <button class="tab-link" onclick="openTab(event, 'TabContext')">📦 Context</button>
              <button class="tab-link" onclick="openTab(event, 'TabAgent')">🤖 Agent & Tools</button>
              <button class="tab-link" onclick="openTab(event, 'TabHerd')">🐂 Herd Mode</button>
              <button class="tab-link" onclick="openTab(event, 'TabPersonas')">🎭 Personas</button>
              <button class="tab-link" onclick="openTab(event, 'TabLog')">📋 Log</button>
            </div>

            <div id="TabApi" class="tab-content active">
              <h2>Connection Settings</h2>
              <label for="backendType">Backend Type</label>
              <select id="backendType">
                <option value="lollms" ${backendType === 'lollms' ? 'selected' : ''}>Lollms Server</option>
                <option value="openai" ${backendType === 'openai' ? 'selected' : ''}>OpenAI Compatible</option>
                <option value="ollama" ${backendType === 'ollama' ? 'selected' : ''}>Ollama</option>
              </select>
              <div class="checkbox-container"><input type="checkbox" id="useLollmsExtensions" ${useLollmsExtensions ? 'checked' : ''}><label for="useLollmsExtensions">Use Lollms Extensions</label></div>
              <label for="apiUrl">API Host</label>
              <div class="input-group"><input type="text" id="apiUrl" value="${apiUrl}"><button id="testConnection" class="icon-btn" title="Test Connection"><i class="codicon codicon-broadcast"></i></button></div>
              <label for="apiKey">API Key</label><input type="text" id="apiKey" value="${apiKey}" autocomplete="off">
              <label for="modelSelect">Chat Model</label>
              <div class="input-group"><select id="modelSelect" class="model-dropdown"></select><button id="refreshModels" class="icon-btn" title="Refresh List"><i class="codicon codicon-refresh"></i></button></div>
            </div>

            <div id="TabGeneral" class="tab-content">
              <h2>User Experience</h2>
              <div class="grid-2">
                <div>
                  <label for="language">Language</label>
                  <select id="language"><option value="auto">Automatic</option><option value="en">English</option></select>
                </div>
                <div>
                   <label for="outputFormat">Global Code Format</label>
                   <select id="outputFormat"><option value="legacy" ${outputFormat === 'legacy' ? 'selected' : ''}>Legacy (Markdown)</option><option value="xml" ${outputFormat === 'xml' ? 'selected' : ''}>XML</option><option value="aider" ${outputFormat === 'aider' ? 'selected' : ''}>Aider</option></select>
                </div>
              </div>
            </div>

            <div id="TabContext" class="tab-content">
              <h2>Context Strategy</h2>
              <label for="failsafeContextSize">Failsafe Context Size (tokens)</label><input type="number" id="failsafeContextSize" value="${failsafeContextSize}">
              <label for="contextFileExceptions">Exclusion Patterns (Glob)</label><textarea id="contextFileExceptions" rows="8">${contextFileExceptions.join('\n')}</textarea>
            </div>

            <div id="TabAgent" class="tab-content">
              <h2>Agent Control</h2>
              <label for="agentMaxRetries">Max Self-Correction Retries</label><input type="number" id="agentMaxRetries" value="${agentMaxRetries}">
              
              <h3>Global Permissions</h3>
              <p class="help-text">Safety gates for automated tools.</p>
              <div class="grid-2">
                  <div class="checkbox-container"><input type="checkbox" id="perm-shell" ${agentPermissions.shellExecution ? 'checked' : ''}><label for="perm-shell">Shell Execution</label></div>
                  <div class="checkbox-container"><input type="checkbox" id="perm-fs-write" ${agentPermissions.filesystemWrite ? 'checked' : ''}><label for="perm-fs-write">File Writing</label></div>
                  <div class="checkbox-container"><input type="checkbox" id="perm-fs-read" ${agentPermissions.filesystemRead ? 'checked' : ''}><label for="perm-fs-read">File Reading</label></div>
                  <div class="checkbox-container"><input type="checkbox" id="perm-net" ${agentPermissions.internetAccess ? 'checked' : ''}><label for="perm-net">Network/Web Access</label></div>
              </div>

              <h3>MCP Tools</h3>
              <textarea id="mcpServers" rows="6" placeholder='{"server": "command"}'>${mcpServers}</textarea>
            </div>

            <!-- ... other tabs ... -->

            <div id="TabLog" class="tab-content"><h2>System Logs</h2><pre id="logContent">Click tab to refresh...</pre></div>

          </div>
          <script>
            const vscode = acquireVsCodeApi();
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
            window.addEventListener('DOMContentLoaded', () => {
                const bind = (id, key) => {
                    const el = document.getElementById(id);
                    if(!el) return;
                    el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
                        let val = el.type === 'checkbox' ? el.checked : el.value;
                        if(el.type === 'number') val = parseInt(val);
                        vscode.postMessage({ command: 'updateTempValue', key, value: val });
                    });
                };
                ['apiKey','apiUrl','backendType','requestTimeout','agentMaxRetries','language','outputFormat','mcpServers'].forEach(k => bind(k, k));
                ['perm-shell','perm-fs-write','perm-fs-read','perm-net'].forEach(id => {
                    const el = document.getElementById(id);
                    const map = {'perm-shell':'shellExecution','perm-fs-write':'filesystemWrite','perm-fs-read':'filesystemRead','perm-net':'internetAccess'};
                    el.addEventListener('change', () => vscode.postMessage({ command: 'updatePermissionValue', key: map[id], value: el.checked }));
                });

                document.getElementById('saveTop').onclick = () => vscode.postMessage({ command: 'saveConfig' });
                document.getElementById('resetTop').onclick = () => vscode.postMessage({ command: 'resetConfig' });
                document.getElementById('closeTop').onclick = () => vscode.postMessage({ command: 'close' });
                document.getElementById('testConnection').onclick = () => vscode.postMessage({ command: 'testConnection' });
                document.getElementById('refreshModels').onclick = () => vscode.postMessage({ command: 'fetchModels', value: true });
            });
            window.addEventListener('message', event => {
                if (event.data.command === 'logData') document.getElementById('logContent').textContent = event.data.content;
                if (event.data.command === 'modelsList') {
                    const sel = document.getElementById('modelSelect');
                    sel.innerHTML = '';
                    event.data.models.forEach(m => sel.appendChild(new Option(m.id, m.id)));
                }
            });
          </script>
        </body>
        </html>`;
  }
}
