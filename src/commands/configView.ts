import * as vscode from 'vscode';
import { LollmsAPI, LollmsConfig } from '../lollmsAPI';
import { Logger } from '../logger';
import { ProcessManager } from '../processManager';
import { PersonalityManager } from '../personalityManager';
import { HerdParticipant, DynamicModelEntry, ResponseProfile } from '../utils';

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
    
    // REPLACED OLD MODES WITH PROFILES
    responseProfiles: [] as ResponseProfile[],
    defaultResponseProfileId: 'balanced',

    generationFormats: {
      fullFile: true,
      diff: true,
      aider: true
    },
    allowedFileFormats: {
      fullFile: true,
      insert: true,
      replace: true,
      delete: true
    },
    
    failsafeContextSize: 8192,
    searchProvider: 'google_custom_search',
    searchApiKey: '',
    searchCx: '',
    autoUpdateChangelog: false,
    autoGenerateTitle: true,
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
    herdPreAnswerParticipants: [] as HerdParticipant[],
    herdPostAnswerParticipants: [] as HerdParticipant[],
    herdRounds: 2,
    herdDynamicMode: false,
    herdDynamicModelPool: [] as DynamicModelEntry[],
    deleteBranchAfterMerge: true,
    unstagedChangesBehavior: 'stash',
    showOs: true,
    showIp: false,
    showShells: true,
    systemCustomInfo: '',
    agentShellExecution: true,
    agentFilesystemWrite: true,
    agentFilesystemRead: true,
    agentInternetAccess: true,
    agentUseRLM: false,
    distillWebResults: true,
    antiPromptInjection: true,
    searchInCacheFirst: true,
    moltbookEnable: false,
    moltbookApiKey: '',
    moltbookBotName: 'Lollms-VS-Bot',
    moltbookBotPurpose: 'An autonomous software engineering assistant integrated with VS Code.',
    
    // Remote Integration Settings
    remoteServerPort: 3000,
    remoteDiscordEnabled: false,
    remoteDiscordToken: '',
    remoteSlackEnabled: false,
    remoteSlackToken: '',
    remoteSlackSigningSecret: '',
    remoteAllowedUsers: [] as string[],
    remoteAdminUsers: [] as string[],
    remoteAllowedChannels: [] as string[]
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
    
    // NEW PROFILES CONFIG
    this._pendingConfig.responseProfiles = config.get<ResponseProfile[]>('responseProfiles') || [];
    this._pendingConfig.defaultResponseProfileId = config.get<string>('defaultResponseProfileId') || 'balanced';

    this._pendingConfig.failsafeContextSize = config.get<number>('failsafeContextSize') || 4096;
    
    this._pendingConfig.searchProvider = config.get<string>('searchProvider') || 'google_custom_search';
    this._pendingConfig.searchApiKey = config.get<string>('searchApiKey') || '';
    this._pendingConfig.searchCx = config.get<string>('searchCx') || '';
    this._pendingConfig.autoUpdateChangelog = config.get<boolean>('autoUpdateChangelog') || false;
    this._pendingConfig.autoGenerateTitle = config.get<boolean>('autoGenerateTitle') ?? true;

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
    this._pendingConfig.herdPreAnswerParticipants = config.get<HerdParticipant[]>('herdPreAnswerParticipants') || [];
    this._pendingConfig.herdPostAnswerParticipants = config.get<HerdParticipant[]>('herdPostAnswerParticipants') || [];
    this._pendingConfig.herdRounds = config.get<number>('herdRounds') || 2;
    this._pendingConfig.herdDynamicMode = config.get<boolean>('herdDynamicMode') || false;
    this._pendingConfig.herdDynamicModelPool = config.get<DynamicModelEntry[]>('herdDynamicModelPool') || [];

    this._pendingConfig.deleteBranchAfterMerge = config.get<boolean>('git.deleteBranchAfterMerge') ?? true;
    this._pendingConfig.unstagedChangesBehavior = config.get<string>('git.unstagedChangesBehavior') || 'stash';

    this._pendingConfig.showOs = config.get<boolean>('systemEnv.showOs') ?? true;
    this._pendingConfig.showIp = config.get<boolean>('systemEnv.showIp') ?? false;
    this._pendingConfig.showShells = config.get<boolean>('systemEnv.showShells') ?? true;
    this._pendingConfig.systemCustomInfo = config.get<string>('systemEnv.customInfo') || '';

    const agentPerms = config.get<any>('agent.permissions') || {};
    this._pendingConfig.agentShellExecution = agentPerms.shellExecution !== false;
    this._pendingConfig.agentFilesystemWrite = agentPerms.filesystemWrite !== false;
    this._pendingConfig.agentFilesystemRead = agentPerms.filesystemRead !== false;
    this._pendingConfig.agentInternetAccess = agentPerms.internetAccess !== false;
    this._pendingConfig.agentUseRLM = config.get<boolean>('agent.useRLM') || false;
    this._pendingConfig.distillWebResults = config.get<boolean>('distillWebResults') ?? true;
    this._pendingConfig.antiPromptInjection = config.get<boolean>('antiPromptInjection') ?? true;
    this._pendingConfig.searchInCacheFirst = config.get<boolean>('searchInCacheFirst') ?? true;

    this._pendingConfig.moltbookEnable = config.get<boolean>('moltbook.enable') || false;
    this._pendingConfig.moltbookApiKey = config.get<string>('moltbook.apiKey') || '';
    this._pendingConfig.moltbookBotName = config.get<string>('moltbook.botName') || 'Lollms-VS-Bot';
    this._pendingConfig.moltbookBotPurpose = config.get<string>('moltbook.botPurpose') || 'An autonomous software engineering assistant integrated with VS Code.';

    // Load Remote Configuration
    this._pendingConfig.remoteServerPort = config.get<number>('remote.server.port') || 3000;
    this._pendingConfig.remoteDiscordEnabled = config.get<boolean>('remote.discord.enabled') || false;
    this._pendingConfig.remoteDiscordToken = config.get<string>('remote.discord.token') || '';
    this._pendingConfig.remoteSlackEnabled = config.get<boolean>('remote.slack.enabled') || false;
    this._pendingConfig.remoteSlackToken = config.get<string>('remote.slack.token') || '';
    this._pendingConfig.remoteSlackSigningSecret = config.get<string>('remote.slack.signingSecret') || '';
    this._pendingConfig.remoteAllowedUsers = config.get<string[]>('remote.allowedUsers') || [];
    this._pendingConfig.remoteAdminUsers = config.get<string[]>('remote.adminUsers') || [];
    this._pendingConfig.remoteAllowedChannels = config.get<string[]>('remote.allowedChannels') || [];

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

  private async handleImportConnection() {
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Config Files': ['env', 'json', 'yaml', 'yml'] }
    });

    if (uris && uris[0]) {
        const fileContent = (await vscode.workspace.fs.readFile(uris[0])).toString();
        const ext = path.extname(uris[0].fsPath).toLowerCase();
        let imported: any = {};

        try {
            if (ext === '.env') {
                fileContent.split('\n').forEach(line => {
                    const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)\s*$/);
                    if (match) {
                        const key = match[1];
                        let val = match[2].trim().replace(/^['"]|['"]$/g, '');
                        if (key === 'LOLLMS_BINDING_NAME') imported.backendType = val;
                        if (key === 'LOLLMS_HOST_ADDRESS') imported.apiUrl = val;
                        if (key === 'LOLLMS_SERVICE_KEY') imported.apiKey = val;
                        if (key === 'LOLLMS_MODEL_NAME') imported.modelName = val;
                        if (key === 'LOLLMS_CERTIFICATE_FILE_PATH') imported.sslCertPath = val;
                        if (key === 'LOLLMS_VERIFY_SSL_CERTIFICATE') {
                            imported.disableSslVerification = !(['1', 'true', 'on'].includes(val.toLowerCase()));
                        }
                    }
                });
            } else if (ext === '.json') {
                imported = JSON.parse(fileContent);
            } else {
                const yaml = require('js-yaml');
                const rawYaml = yaml.load(fileContent);
                const data = rawYaml.lollms_connection || rawYaml;
                imported = {
                    backendType: data.backend || data.backendType,
                    apiUrl: data.host || data.apiUrl,
                    apiKey: data.key || data.apiKey,
                    modelName: data.model || data.modelName,
                    sslCertPath: data.cert_path || data.sslCertPath,
                    disableSslVerification: data.verify_ssl !== undefined ? !data.verify_ssl : data.disableSslVerification
                };
            }

            Object.assign(this._pendingConfig, imported);
            this._panel.webview.postMessage({ command: 'refreshForm', config: this._pendingConfig });
            vscode.window.showInformationMessage("Connection settings imported successfully.");
        } catch (e) {
            vscode.window.showErrorMessage("Failed to parse config file.");
        }
    }
  }

  private async handleExportConnection() {
    const format = await vscode.window.showQuickPick(['.env (Lollms Standard)', 'JSON', 'YAML'], { placeHolder: 'Select export format' });
    if (!format) return;

    let content = "";
    let fileName = "lollms_config";
    const cfg = this._pendingConfig;

    if (format === '.env (Lollms Standard)') {
        fileName += ".env";
        content = [
            `LOLLMS_BINDING_NAME=${cfg.backendType}`,
            `LOLLMS_HOST_ADDRESS=${cfg.apiUrl}`,
            `LOLLMS_SERVICE_KEY=${cfg.apiKey}`,
            `LOLLMS_VERIFY_SSL_CERTIFICATE=${!cfg.disableSslVerification}`,
            `LOLLMS_CERTIFICATE_FILE_PATH=${cfg.sslCertPath}`,
            `LOLLMS_MODEL_NAME=${cfg.modelName}`
        ].join('\n');
    } else if (format === 'JSON') {
        fileName += ".json";
        content = JSON.stringify({
            backendType: cfg.backendType,
            apiUrl: cfg.apiUrl,
            apiKey: cfg.apiKey,
            disableSslVerification: cfg.disableSslVerification,
            sslCertPath: cfg.sslCertPath,
            modelName: cfg.modelName
        }, null, 2);
    } else {
        fileName += ".yaml";
        const jsYaml = require('js-yaml');
        content = jsYaml.dump({
            lollms_connection: {
                backend: cfg.backendType,
                host: cfg.apiUrl,
                key: cfg.apiKey,
                verify_ssl: !cfg.disableSslVerification,
                cert_path: cfg.sslCertPath,
                model: cfg.modelName
            }
        });
    }

    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(fileName) });
    if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        vscode.window.showInformationMessage(`Connection config exported to ${path.basename(uri.fsPath)}`);
    }
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
        async (message: { command: string; key?: string; value?: any; profiles?: any[]; defaultId?: string }) => {
          Logger.info(`[ConfigView] Received command: ${message.command}`);

          switch (message.command) {
            case 'webviewReady':
                Logger.info('[ConfigView] Webview reported ready.');
                return;
            case 'copyToClipboard':
                if (message.value) {
                    await vscode.env.clipboard.writeText(message.value);
                    vscode.window.showInformationMessage("Copied to clipboard.");
                }
                return;
            case 'exportConnectionConfig':
                await this.handleExportConnection();
                return;
            case 'importConnectionConfig':
                await this.handleImportConnection();
                return;
            case 'closePanel':
              this.dispose();
              return;

            case 'updateTempValue':
              if (message.key && message.key in this._pendingConfig) {
                // Special handling for array text areas (split by newline)
                if (['contextFileExceptions', 'remoteAllowedUsers', 'remoteAdminUsers', 'remoteAllowedChannels'].includes(message.key as string)) {
                     if (Array.isArray(message.value)) {
                         (this._pendingConfig as any)[message.key as string] = message.value;
                     } else {
                         (this._pendingConfig as any)[message.key as string] = String(message.value).split('\n').map(s => s.trim()).filter(s => s);
                     }
                } else {
                    (this._pendingConfig as any)[message.key!] = message.value;
                }
              }
              return;
            
            case 'updateProfiles':
                if (message.profiles) this._pendingConfig.responseProfiles = message.profiles;
                if (message.defaultId) this._pendingConfig.defaultResponseProfileId = message.defaultId;
                return;

            case 'exportProfiles':
                const content = JSON.stringify(this._pendingConfig.responseProfiles, null, 2);
                const uri = await vscode.window.showSaveDialog({ filters: {'JSON': ['json']}, saveLabel: 'Export Profiles' });
                if(uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
                return;

            case 'importProfiles':
                const openUris = await vscode.window.showOpenDialog({ filters: {'JSON': ['json']}, canSelectMany: false });
                if(openUris && openUris[0]) {
                    const fileData = await vscode.workspace.fs.readFile(openUris[0]);
                    try {
                        const newProfiles = JSON.parse(Buffer.from(fileData).toString());
                        if(Array.isArray(newProfiles)) {
                            this._pendingConfig.responseProfiles = newProfiles;
                            this._panel.webview.postMessage({ command: 'refreshProfiles', profiles: newProfiles });
                        }
                    } catch(e) { vscode.window.showErrorMessage("Invalid profile file."); }
                }
                return;

            case 'updateGenerationFormat':
              if (message.key) {
                  (this._pendingConfig.generationFormats as any)[message.key] = message.value;
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
                const failures: { key: string; error: string }[] = [];

                const safeUpdate = async (key: string, value: any) => {
                  try {
                    const inspect = config.inspect(key);
                    let target = vscode.ConfigurationTarget.Global;
                    if (inspect?.workspaceValue !== undefined) {
                        target = vscode.ConfigurationTarget.Workspace;
                    }
                    Logger.debug(`Updating config key '${key}' to target: ${target === vscode.ConfigurationTarget.Global ? 'Global' : 'Workspace'}`, value);
                    await config.update(key, value, target);
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
                  
                  // NEW PROFILES
                  ['responseProfiles', this._pendingConfig.responseProfiles],
                  ['defaultResponseProfileId', this._pendingConfig.defaultResponseProfileId],

                  ['failsafeContextSize', this._pendingConfig.failsafeContextSize],
                  ['searchProvider', this._pendingConfig.searchProvider],
                  ['searchApiKey', this._pendingConfig.searchApiKey],
                  ['searchCx', this._pendingConfig.searchCx],
                  ['autoUpdateChangelog', this._pendingConfig.autoUpdateChangelog],
                  ['autoGenerateTitle', this._pendingConfig.autoGenerateTitle],
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
                  ['herdPreAnswerParticipants', this._pendingConfig.herdPreAnswerParticipants],
                  ['herdPostAnswerParticipants', this._pendingConfig.herdPostAnswerParticipants],
                  ['herdRounds', this._pendingConfig.herdRounds],
                  ['herdDynamicMode', this._pendingConfig.herdDynamicMode],
                  ['herdDynamicModelPool', this._pendingConfig.herdDynamicModelPool],
                  ['git.deleteBranchAfterMerge', this._pendingConfig.deleteBranchAfterMerge],
                  ['git.unstagedChangesBehavior', this._pendingConfig.unstagedChangesBehavior],
                  ['systemEnv.showOs', this._pendingConfig.showOs],
                  ['systemEnv.showIp', this._pendingConfig.showIp],
                  ['systemEnv.showShells', this._pendingConfig.showShells],
                  ['systemEnv.customInfo', this._pendingConfig.systemCustomInfo],
                  ['agent.permissions', {
                      shellExecution: this._pendingConfig.agentShellExecution,
                      filesystemWrite: this._pendingConfig.agentFilesystemWrite,
                      filesystemRead: this._pendingConfig.agentFilesystemRead,
                      internetAccess: this._pendingConfig.agentInternetAccess
                  }],
                  ['agent.useRLM', this._pendingConfig.agentUseRLM],
                  ['distillWebResults', this._pendingConfig.distillWebResults],
                  ['antiPromptInjection', this._pendingConfig.antiPromptInjection],
                  ['searchInCacheFirst', this._pendingConfig.searchInCacheFirst],
                  ['moltbook.enable', this._pendingConfig.moltbookEnable],
                  ['moltbook.apiKey', this._pendingConfig.moltbookApiKey],
                  ['moltbook.botName', this._pendingConfig.moltbookBotName],
                  ['moltbook.botPurpose', this._pendingConfig.moltbookBotPurpose],
                  
                  // Remote Settings
                  ['remote.server.port', this._pendingConfig.remoteServerPort],
                  ['remote.discord.enabled', this._pendingConfig.remoteDiscordEnabled],
                  ['remote.discord.token', this._pendingConfig.remoteDiscordToken],
                  ['remote.slack.enabled', this._pendingConfig.remoteSlackEnabled],
                  ['remote.slack.token', this._pendingConfig.remoteSlackToken],
                  ['remote.slack.signingSecret', this._pendingConfig.remoteSlackSigningSecret],
                  ['remote.allowedUsers', this._pendingConfig.remoteAllowedUsers],
                  ['remote.adminUsers', this._pendingConfig.remoteAdminUsers],
                  ['remote.allowedChannels', this._pendingConfig.remoteAllowedChannels]
                ];

                for (const [key, value] of updates) {
                  await safeUpdate(key, value);
                }

                if (failures.length === 0) {
                  vscode.window.showInformationMessage(
                    vscode.l10n.t({ key: 'info.configSaved', message: 'Configuration saved. Recreating LollmsAPI...' })
                  );
                  Logger.info('Configuration saved successfully.');
                  await vscode.commands.executeCommand('lollmsApi.recreateClient');
                  SettingsPanel.currentPanel?.dispose();
                } else {
                  const errorDetails = failures.map(f => `  • ${f.key}: ${f.error}`).join('\n');
                  const failMsg = `Configuration saved with ${failures.length} error(s):\n\n${errorDetails}`;
                  vscode.window.showErrorMessage(failMsg, { modal: true });
                }
              } catch (err) {
                vscode.window.showErrorMessage('Failed to save configuration.');
                Logger.error('Unexpected error during configuration save', err);
              }
              return;

            case 'resetConfig':
                const selection = await vscode.window.showWarningMessage(
                    "Reset all Lollms configurations?",
                    { modal: true },
                    "Reset"
                );
                
                if (selection === "Reset") {
                    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                    const keys = [
                        'apiKey', 'apiUrl', 'backendType', 'useLollmsExtensions', 'modelName', 
                        'architectModelName', 'disableSslVerification', 'sslCertPath', 
                        'requestTimeout', 'agentMaxRetries', 'maxImageSize', 'enableCodeInspector',
                        'inspectorModelName', 'codeInspectorPersona', 'chatPersona', 'agentPersona',
                        'commitMessagePersona', 'contextFileExceptions', 'language', 'generationFormats', 'explainCode', 'allowedFileFormats', 
                        'reasoningLevel', 'failsafeContextSize', 'searchProvider', 'searchApiKey',
                        'searchCx', 'autoUpdateChangelog', 'autoGenerateTitle', 
                        'addPedagogicalInstruction', 'forceFullCodePath', 'clipboardInsertRole', 'companion.enableWebSearch',
                        'companion.enableArxivSearch', 'userInfo.name', 'userInfo.email', 
                        'userInfo.license', 'userInfo.codingStyle', 'enableCodeActions', 
                        'enableInlineSuggestions', 'mcpServers', 'herdParticipants', 
                        'herdPreAnswerParticipants', 'herdPostAnswerParticipants', 'herdRounds', 
                        'herdDynamicMode', 'herdDynamicModelPool', 'git.deleteBranchAfterMerge',
                        'git.unstagedChangesBehavior', 'systemEnv.showOs', 'systemEnv.showIp', 
                        'systemEnv.showShells', 'systemEnv.customInfo', 'agent.permissions', 'agent.useRLM',
                        'moltbook.enable', 'moltbook.apiKey', 'moltbook.botName', 'moltbook.botPurpose',
                        'remote.server.port', 'remote.discord.enabled', 'remote.discord.token',
                        'remote.slack.enabled', 'remote.slack.token', 'remote.slack.signingSecret',
                        'remote.allowedUsers', 'remote.adminUsers', 'remote.allowedChannels',
                        'responseProfiles', 'defaultResponseProfileId'
                    ];
                    
                    try {
                        for (const key of keys) {
                            await config.update(key, undefined, vscode.ConfigurationTarget.Global);
                            await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
                            await config.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
                        }
                        
                        vscode.window.showInformationMessage("Configuration reset.");
                        await vscode.commands.executeCommand('lollmsApi.recreateClient');
                        SettingsPanel.currentPanel?.dispose();
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to reset configuration: ${e.message}`);
                    }
                }
                return;
  
            case 'fetchModels':
              if (this._panel) {
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
                } catch (e: any) {
                  this._panel.webview.postMessage({ command: 'modelsList', models: [], error: e.message });
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
    const { apiKey, apiUrl, backendType, useLollmsExtensions, modelName, architectModelName, disableSslVerification, sslCertPath, requestTimeout, agentMaxRetries, maxImageSize, enableCodeInspector, inspectorModelName, codeInspectorPersona, chatPersona, agentPersona, commitMessagePersona, contextFileExceptions, language, generationFormats, forceFullCode, explainCode, allowedFileFormats, reasoningLevel, failsafeContextSize, searchProvider, searchApiKey, searchCx, autoUpdateChangelog, autoGenerateTitle, addPedagogicalInstruction, forceFullCodePath, clipboardInsertRole, companionEnableWebSearch, companionEnableArxivSearch, userInfoName, userInfoEmail, userInfoLicense, userInfoCodingStyle, enableCodeActions, enableInlineSuggestions, mcpServers, herdParticipants, herdPreAnswerParticipants, herdPostAnswerParticipants, herdRounds, herdDynamicMode, herdDynamicModelPool, deleteBranchAfterMerge, unstagedChangesBehavior, showOs, showIp, showShells, systemCustomInfo, agentShellExecution, agentFilesystemWrite, agentFilesystemRead, agentInternetAccess, agentUseRLM, moltbookEnable, moltbookApiKey, moltbookBotName, moltbookBotPurpose, remoteServerPort, remoteDiscordEnabled, remoteDiscordToken, remoteSlackEnabled, remoteSlackToken, remoteSlackSigningSecret, remoteAllowedUsers, remoteAdminUsers, remoteAllowedChannels } = config;

    const t = (key: string, def: string) => vscode.l10n.t({ message: def, key: key });
    
    const personalities = this._personalityManager.getPersonalities();
    
    const stateData = {
        config: config,
        personalities: this._personalityManager.getPersonalities(),
        herdPre: config.herdPreAnswerParticipants || [],
        herdPost: config.herdPostAnswerParticipants || [],
        herdPool: config.herdDynamicModelPool || []
    };
    
    const jsonState = JSON.stringify(stateData).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource}; img-src data:; font-src ${webview.cspSource};">
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>${t('config.title', 'Lollms VS Coder Configuration')}</title>
            <link href="${webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'))}" rel="stylesheet" />
            <style>
              :root { 
                --primary-accent: var(--vscode-button-background); 
                --primary-accent-hover: var(--vscode-button-hoverBackground); 
                --success-color: var(--vscode-charts-green); 
                --warning-color: var(--vscode-charts-orange); 
                --error-color: var(--vscode-charts-red); 
                --border-radius: 6px; 
                --border-radius-sm: 3px; 
                --transition: all 0.2s ease; 
              }
              body, html { height: 100%; width:100%; margin: 0; padding: 0; font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-size: 13px; line-height: 1.4; }
              .container { padding: 20px; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; max-width: 1000px; margin: 0 auto; }
              .header-row { display: flex; align-items: center; gap: 20px; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
              .toolbar { display: flex; gap: 8px; }
              .toolbar-btn { background: transparent; border: 1px solid var(--vscode-panel-border); border-radius: var(--border-radius-sm); width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--vscode-foreground); transition: var(--transition); padding: 0; }
              .toolbar-btn:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--primary-accent); }
              .toolbar-btn.save:hover { color: var(--success-color); border-color: var(--success-color); }
              .toolbar-btn.reset:hover { color: var(--warning-color); border-color: var(--warning-color); }
              .toolbar-btn.close:hover { color: var(--error-color); border-color: var(--error-color); }
              .toolbar-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
              h1 { font-weight: 600; margin: 0; font-size: 16px; flex-grow: 1; }
              .tabs { display: flex; background: var(--vscode-sideBar-background); border-radius: var(--border-radius); padding: 4px; margin-bottom: 20px; flex-wrap: wrap; gap: 2px; border: 1px solid var(--vscode-panel-border); }
              .tab-link { background: transparent; border: none; outline: none; cursor: pointer; padding: 6px 12px; color: var(--vscode-foreground); font-size: 12px; border-radius: var(--border-radius-sm); transition: var(--transition); }
              .tab-link:hover { background: var(--vscode-toolbar-hoverBackground); }
              .tab-link.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
              .tab-content { display: none; flex-grow: 1; overflow-y: auto; padding: 24px; background: var(--vscode-editorWidget-background); border-radius: var(--border-radius); border: 1px solid var(--vscode-widget-border); }
              .tab-content.active { display: block; }
              h2 { font-weight: 600; font-size: 16px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; margin-top: 0; margin-bottom: 20px; color: var(--vscode-textLink-foreground); }
              h3 { font-size: 14px; margin-top: 24px; margin-bottom: 12px; font-weight: 600; color: var(--vscode-foreground); border-left: 3px solid var(--primary-accent); padding-left: 10px; }
              label { display: block; margin-top: 16px; margin-bottom: 6px; font-weight: 600; font-size: 12px; color: var(--vscode-foreground); opacity: 0.9; }
              input[type="text"], input[type="password"], input[type="number"], textarea, select { width: 100%; padding: 6px 10px; border: 1px solid var(--vscode-input-border); border-radius: var(--border-radius-sm); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-size: 13px; box-sizing: border-box; font-family: inherit; }
              input:focus, textarea:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
              textarea { resize: vertical; min-height: 80px; font-family: var(--vscode-editor-font-family); }
              button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; font-size: 13px; font-weight: 600; border-radius: var(--border-radius-sm); cursor: pointer; }
              button.primary:hover { background: var(--vscode-button-hoverBackground); }
              .secondary-button { padding: 6px 12px; font-size: 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: var(--border-radius-sm); cursor: pointer; }
              .secondary-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
              .icon-btn { padding: 6px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: var(--border-radius-sm); cursor: pointer; display: flex; align-items: center; justify-content: center; }
              .icon-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
              .checkbox-container { display: flex; align-items: center; margin-top: 10px; gap: 10px; }
              .checkbox-container input { width: 14px; height: 14px; cursor: pointer; margin: 0; }
              .checkbox-container label { margin: 0; cursor: pointer; font-weight: normal; }
              .input-group { display: flex; gap: 6px; align-items: stretch; }
              .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
              .participant-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; padding: 8px; background: var(--vscode-editor-background); border-radius: var(--border-radius-sm); border: 1px solid var(--vscode-widget-border); }
              .participant-row select, .participant-row input { flex: 1; }
              .remove-btn { color: var(--error-color); border: 1px solid var(--error-color); }
              .remove-btn:hover { background: var(--error-color) !important; color: white !important; }
              .help-text { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
              .persona-selector-row { display: flex; gap: 10px; align-items: center; margin-top: 4px; }
              .persona-selector-row select { flex: 1; font-size: 12px; }
              .log-container { background: var(--vscode-editor-background); padding: 12px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; height: 300px; overflow: auto; }
              .security-warning { background: rgba(244, 135, 113, 0.1); border: 1px solid var(--error-color); border-radius: var(--border-radius-sm); padding: 12px; margin-top: 15px; color: var(--error-color); }
              .security-warning strong { display: block; margin-bottom: 4px; }
            </style>
        </head>
        <body>
          <div class="container">
            <div class="header-row">
              <div class="toolbar">
                <button class="toolbar-btn save" id="saveToolbar" title="Save Configuration"><svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v13a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg></button>
                <button class="toolbar-btn reset" id="resetToolbar" title="Reset to Defaults"><svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg></button>
                <button class="toolbar-btn close" id="closeToolbar" title="Close Panel"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
              </div>
              <h1>${t('config.title', 'Lollms VS Coder Configuration')}</h1>
            </div>
          
            <div class="tabs">
              <button class="tab-link active" onclick="openTab(event, 'TabApi')">🔌 API & Model</button>
              <button class="tab-link" onclick="openTab(event, 'TabGeneral')">⚡ General</button>
              <button class="tab-link" onclick="openTab(event, 'TabContext')">🧠 Context</button>
              <button class="tab-link" onclick="openTab(event, 'TabAgent')">🤖 Agent & Tools</button>
              <button class="tab-link" onclick="openTab(event, 'TabRemote')">📡 Remote</button>
              <button class="tab-link" onclick="openTab(event, 'TabGit')">🐙 Git</button>
              <button class="tab-link" onclick="openTab(event, 'TabHerd')">🐂 Herd Mode</button>
              <button class="tab-link" onclick="openTab(event, 'TabPersonas')">🎭 Personas</button>
              <button class="tab-link" onclick="openTab(event, 'TabUser')">👤 User Info</button>
              <button class="tab-link" onclick="openTab(event, 'TabLog')">📋 Log</button>
            </div>

    <!-- TabApi Content -->
    <div id="TabApi" class="tab-content active">
        <div style="display:flex; justify-content: space-between; align-items: center;">
            <h2 style="margin:0; border:none; padding:0;">${t('config.section.apiAndModel', 'API & Model')}</h2>
            <div style="display:flex; gap:8px;">
                <button id="importConfig" class="secondary-button" style="margin:0;"><i class="codicon codicon-cloud-upload"></i> Import</button>
                <button id="exportConfig" class="secondary-button" style="margin:0;"><i class="codicon codicon-cloud-download"></i> Export</button>
            </div>
        </div>

        <label for="backendType">Backend Type</label>
        <select id="backendType">
            <option value="lollms" ${backendType === 'lollms' ? 'selected' : ''}>Lollms Server</option>
            <option value="openai" ${backendType === 'openai' ? 'selected' : ''}>OpenAI Compatible</option>
            <option value="ollama" ${backendType === 'ollama' ? 'selected' : ''}>Ollama</option>
            <option value="anthropic" ${backendType === 'anthropic' ? 'selected' : ''}>Anthropic Claude</option>
            <option value="google" ${backendType === 'google' ? 'selected' : ''}>Google Gemini</option>
            <option value="groq" ${backendType === 'groq' ? 'selected' : ''}>Groq</option>
            <option value="grok" ${backendType === 'grok' ? 'selected' : ''}>xAI Grok</option>
            <option value="novitai" ${backendType === 'novitai' ? 'selected' : ''}>Novita AI</option>
            <option value="openwebui" ${backendType === 'openwebui' ? 'selected' : ''}>Open WebUI</option>
            <option value="openrouter" ${backendType === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
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
                <div class="input-group">
                    <input type="password" id="apiKey" value="${apiKey}" placeholder="Enter your API key" autocomplete="off" style="flex:1;" />
                    <button id="toggleApiKey" type="button" class="icon-btn" title="Show/Hide"><i class="codicon codicon-eye"></i></button>
                    <button id="copyApiKey" type="button" class="icon-btn" title="Copy Key"><i class="codicon codicon-copy"></i></button>
                </div>

                <label for="modelSelect">${t('config.modelName.label', 'Chat Model')}</label>
                <div class="input-group">
                    <select id="modelSelect" class="model-dropdown" style="flex:1;">
                        <option value="">Loading Models...</option>
                    </select>
                    <button id="copyModelName" type="button" class="icon-btn" title="Copy Model Name"><i class="codicon codicon-copy"></i></button>
                    <button id="refreshModels" type="button" class="icon-btn" title="${t('command.refresh.title', 'Refresh')}"><i class="codicon codicon-refresh"></i></button>
                </div>
                <label for="architectModelSelect">Architect/Planner Model (Agent Mode)</label>
                <div class="input-group">
                    <select id="architectModelSelect" class="model-dropdown">
                        <option value="">Loading Models...</option>
                    </select>
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

              <h3>Editor Integration</h3>
              <div class="checkbox-container"><input type="checkbox" id="enableCodeActions" ${enableCodeActions ? 'checked' : ''}><label for="enableCodeActions">Enable Lollms Code Actions (CodeLens)</label></div>
              <div class="checkbox-container"><input type="checkbox" id="enableInlineSuggestions" ${enableInlineSuggestions ? 'checked' : ''}><label for="enableInlineSuggestions">Enable Inline Ghost Text Suggestions</label></div>

              <div class="checkbox-container"><input type="checkbox" id="autoGenerateTitle" ${autoGenerateTitle ? 'checked' : ''}><label for="autoGenerateTitle">Auto-generate discussion titles</label></div>
              <div class="checkbox-container"><input type="checkbox" id="addPedagogicalInstruction" ${addPedagogicalInstruction ? 'checked' : ''}><label for="addPedagogicalInstruction">Add Pedagogical Instruction (Hidden)</label></div>

              <h3>Response Profiles</h3>
              <p class="help-text">Define custom response styles (Problem/Hypothesis/Fix, Minimalist, etc.)</p>
              <label for="defaultProfileSelect">Default Profile</label>
              <select id="defaultProfileSelect"></select>

              <div id="profiles-container" style="display:flex; flex-direction:column; gap:8px; margin-top:15px;"></div>
              
              <button id="addProfileBtn" class="secondary-button" style="margin-top:10px;"><i class="codicon codicon-add"></i> Add New Profile</button>
              <div style="display:flex; gap:10px; margin-top:10px;">
                  <button id="importProfileBtn" class="secondary-button"><i class="codicon codicon-cloud-upload"></i> Import</button>
                  <button id="exportProfileBtn" class="secondary-button"><i class="codicon codicon-cloud-download"></i> Export</button>
              </div>

              <!-- Profile Editor (Hidden) -->
              <div id="profile-editor" style="display:none; border: 1px solid var(--vscode-focusBorder); padding: 15px; border-radius: 4px; margin-top: 15px; background: var(--vscode-editor-inactiveSelectionBackground);">
                  <h4 style="margin-top:0;">Edit Profile</h4>
                  <label>Internal ID</label>
                  <input type="text" id="p_id" placeholder="e.g. senior_coder">
                  <label>Display Name</label>
                  <input type="text" id="p_name">
                  <label>Description</label>
                  <input type="text" id="p_desc">
                  <label>Command Prefix (Optional)</label>
                  <input type="text" id="p_prefix" placeholder="/no_think">
                  <label>System Prompt Instructions</label>
                  <textarea id="p_prompt" rows="5"></textarea>
                  <div style="display:flex; gap:10px; margin-top:15px; justify-content:flex-end;">
                      <button id="p_cancel" class="secondary-button">Cancel</button>
                      <button id="p_save" class="primary">Save Profile</button>
                  </div>
              </div>
            </div>

            <div id="TabContext" class="tab-content">
              <h2>Environment & Exceptions</h2>
              <h3 style="margin-top:20px;">Size Limits & Exceptions</h3>
              <label for="failsafeContextSize">${t('config.failsafeContextSize.label', 'Failsafe Context Size')}</label>
              <input type="number" id="failsafeContextSize" value="${failsafeContextSize}" min="1024" step="1024" />
              <label for="maxImageSize">${t('config.maxImageSize.label', 'Max Image Size (px)')}</label>
              <input type="number" id="maxImageSize" value="${maxImageSize}" min="0" step="128" />
              <label for="contextFileExceptions">${t('config.contextFileExceptions.label', 'Context File Exceptions')}</label>
              <textarea id="contextFileExceptions" rows="8">${contextFileExceptions.join('\n')}</textarea>
              
              <h3>Environment Information</h3>
              <div class="checkbox-container"><input type="checkbox" id="showOs" ${showOs ? 'checked' : ''}><label for="showOs">Share Operating System (OS)</label></div>
              <div class="checkbox-container"><input type="checkbox" id="showIp" ${showIp ? 'checked' : ''}><label for="showIp">Share Local IP Addresses</label></div>
              <div class="checkbox-container"><input type="checkbox" id="showShells" ${showShells ? 'checked' : ''}><label for="showShells">Share Available Shells</label></div>
              <label for="systemCustomInfo">Additional Environment Context</label>
              <textarea id="systemCustomInfo" rows="3" placeholder="e.g. 'I am using Git Bash as my default terminal on Windows'">${systemCustomInfo}</textarea>
            </div>

            <!-- TabAgent -->
            <div id="TabAgent" class="tab-content">
              <h2>${t('config.section.agentAndInspector', 'Agent & Tools')}</h2>
              
              <h3>Execution & Self-Correction</h3>
              <label for="agentMaxRetries">${t('config.agentMaxRetries.label', 'Agent Self-Correction Retries')}</label>
              <input type="number" id="agentMaxRetries" value="${agentMaxRetries}" min="0" max="5" />
              
              <div class="checkbox-container"><input type="checkbox" id="enableCodeInspector" ${enableCodeInspector ? 'checked' : ''}><label for="enableCodeInspector">${t('config.enableCodeInspector.label', 'Enable Code Inspector')}</label></div>
              <label for="inspectorModelName">${t('config.inspectorModelName.label', 'Inspector Model Name')}</label>
              <div class="input-group">
                  <select id="inspectorModelName" class="model-dropdown"></select>
                  <button id="refreshInspectorModels" type="button" class="icon-btn" title="${t('command.refresh.title', 'Refresh')}"><i class="codicon codicon-refresh"></i></button>
              </div>

              <h3>Recursive Language Model (RLM)</h3>
              <div class="checkbox-container"><input type="checkbox" id="agentUseRLM" ${agentUseRLM ? 'checked' : ''}><label for="agentUseRLM">Enable RLM with REPL</label></div>
              <p class="help-text">Allow the agent to maintain persistent python state across calls using a REPL environment. Essential for complex multi-step reasoning.</p>

              <h3>Security & Permissions</h3>
              <div class="grid-2">
                <div class="checkbox-container"><input type="checkbox" id="agentShellExecution" ${agentShellExecution ? 'checked' : ''}><label for="agentShellExecution">Shell Execution (Terminal)</label></div>
                <div class="checkbox-container"><input type="checkbox" id="agentFilesystemWrite" ${agentFilesystemWrite ? 'checked' : ''}><label for="agentFilesystemWrite">Filesystem Write (Save/Modify)</label></div>
                <div class="checkbox-container"><input type="checkbox" id="agentFilesystemRead" ${agentFilesystemRead ? 'checked' : ''}><label for="agentFilesystemRead">Filesystem Read (Open/List)</label></div>
                <div class="checkbox-container"><input type="checkbox" id="agentInternetAccess" ${agentInternetAccess ? 'checked' : ''}><label for="agentInternetAccess">Internet Access (Search/Scrape)</label></div>
              </div>

              <h3>Moltbook Connection (Social)</h3>
              <div class="security-warning">
                <strong>⚠️ SECURITY WARNING</strong>
                Enabling Moltbook allowing the AI Agent to post, comment, and read feeds on the Moltbook. 
                The AI may accidentally leak your code or project information if explicitly asked to post about it.
              </div>
              <div class="checkbox-container">
                  <input type="checkbox" id="moltbookEnable" ${moltbookEnable ? 'checked' : ''}>
                  <label for="moltbookEnable">Enable Moltbook Connection</label>
              </div>
              <label for="moltbookApiKey">Moltbook API Key</label>
              <input type="text" id="moltbookApiKey" value="${moltbookApiKey}" placeholder="Moltbook v1 API Key..." autocomplete="off" />
              <p class="help-text">Keys are checked in order: .env file (MOLTBOOK_API_KEY) -> Environment Variable -> Config above.</p>
              
              <label for="moltbookBotName">Bot Identity: Name</label>
              <input type="text" id="moltbookBotName" value="${moltbookBotName}" placeholder="e.g. My-Cusom-Bot" />
              
              <label for="moltbookBotPurpose">Bot Identity: Purpose</label>
              <textarea id="moltbookBotPurpose" rows="3" placeholder="Explain what your bot is for...">${moltbookBotPurpose}</textarea>

              <h3>Web Search</h3>
              <label for="searchApiKey">Google Custom Search API Key</label>
              <input type="text" id="searchApiKey" value="${searchApiKey}" placeholder="Enter API Key" />
              <label for="searchCx">Search Engine ID (CX)</label>
              <input type="text" id="searchCx" value="${searchCx}" placeholder="Enter CX" />
              
              <h3>Companion</h3>
              <div class="checkbox-container"><input type="checkbox" id="companionEnableWebSearch" ${companionEnableWebSearch ? 'checked' : ''}><label for="companionEnableWebSearch">Enable Web Search in Companion</label></div>
              <div class="checkbox-container"><input type="checkbox" id="companionEnableArxivSearch" ${companionEnableArxivSearch ? 'checked' : ''}><label for="companionEnableArxivSearch">Enable ArXiv Search in Companion</label></div>

              <h3>MCP Servers Configuration</h3>
                            <p class="help-text">Connect to external tools using the <strong>Model Context Protocol</strong>. This allows the AI Agent to use local or remote tools for research, memory, and more.</p>
              
              <div class="mcp-help-box">
                <strong>Format:</strong> <code>{ "server-name": "execution-command args" }</code>
                <br><br>
                <strong>Examples:</strong>
                <div class="mcp-example">"filesystem": "npx -y @modelcontextprotocol/server-filesystem /path/to/search"</div>
                <div class="mcp-example">"google-maps": "npx -y @modelcontextprotocol/server-google-maps"</div>
                <div class="mcp-example">"memory": "python -m mcp_server_memory"</div>
              </div>

              <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 15px;">
                <label for="mcpServers" style="margin:0;">MCP Servers (JSON)</label>
                <button id="formatMcpBtn" class="secondary-button" style="margin:0; padding: 4px 8px;">Prettify JSON</button>
              </div>
              <textarea id="mcpServers" rows="8" placeholder='{"server-name": "command arg1 arg2"}' style="font-family: monospace; margin-top: 5px;">${mcpServers}</textarea>
            </div>

            <!-- TabRemote (NEW) -->
            <div id="TabRemote" class="tab-content">
                <h2>Remote Agent Integration</h2>
                <p class="help-text">Allows the Agent to interact via external platforms. Ensure you restrict access to trusted users.</p>
                
                <h3>Webhook Server (Push)</h3>
                <label for="remoteServerPort">Server Port</label>
                <input type="number" id="remoteServerPort" value="${remoteServerPort}" />
                <p class="help-text">Local port for incoming webhooks. Use ngrok to expose this if needed.</p>

                <h3>Platforms</h3>
                
                <!-- Discord -->
                <div class="checkbox-container">
                    <input type="checkbox" id="remoteDiscordEnabled" ${remoteDiscordEnabled ? 'checked' : ''}>
                    <label for="remoteDiscordEnabled">Enable Discord Integration</label>
                </div>
                <label for="remoteDiscordToken">Discord Bot Token</label>
                <input type="text" id="remoteDiscordToken" value="${remoteDiscordToken}" placeholder="Bot Token..." autocomplete="off" />
                
                <!-- Slack -->
                <div class="checkbox-container">
                    <input type="checkbox" id="remoteSlackEnabled" ${remoteSlackEnabled ? 'checked' : ''}>
                    <label for="remoteSlackEnabled">Enable Slack Integration</label>
                </div>
                <label for="remoteSlackToken">Slack Bot Token (xoxb-...)</label>
                <input type="text" id="remoteSlackToken" value="${remoteSlackToken}" placeholder="xoxb-..." autocomplete="off" />
                <label for="remoteSlackSigningSecret">Slack Signing Secret (for Events API)</label>
                <input type="text" id="remoteSlackSigningSecret" value="${remoteSlackSigningSecret}" placeholder="Signing Secret..." autocomplete="off" />

                <h3>Access Control List (ACL)</h3>
                <div class="security-warning">
                    <strong>⚠️ SECURITY WARNING</strong>
                    Only add trusted User IDs. "Admin" users can execute shell commands and modify files.
                </div>
                
                <label for="remoteAllowedUsers">Allowed Users (User IDs, one per line)</label>
                <textarea id="remoteAllowedUsers" rows="3" placeholder="U12345678">${remoteAllowedUsers.join('\n')}</textarea>
                
                <label for="remoteAdminUsers">Admin Users (Can Execute Tools) (User IDs, one per line)</label>
                <textarea id="remoteAdminUsers" rows="3" placeholder="U12345678">${remoteAdminUsers.join('\n')}</textarea>
                
                <label for="remoteAllowedChannels">Allowed Channels (Channel IDs, one per line)</label>
                <textarea id="remoteAllowedChannels" rows="3" placeholder="C12345678">${remoteAllowedChannels.join('\n')}</textarea>
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
              <div class="checkbox-container"><input type="checkbox" id="herdDynamicMode" ${herdDynamicMode ? 'checked' : ''}><label for="herdDynamicMode">Dynamic Herd Mode (AI builds the team for you)</label></div>
              <label for="herdRounds">Number of Rounds</label>
              <input type="number" id="herdRounds" value="${herdRounds}" min="1" max="10" />
              <div id="static-herd-config" style="display: ${herdDynamicMode ? 'none' : 'block'};">
                  <h3>Phase 1: Brainstorming Agents</h3>
                  <div id="herd-pre-list"></div>
                  <button id="addPreParticipantBtn" class="secondary-button"><i class="codicon codicon-add"></i> Add Agent</button>
                  <h3>Phase 3: Critique & Review Agents</h3>
                  <div id="herd-post-list"></div>
                  <button id="addPostParticipantBtn" class="secondary-button"><i class="codicon codicon-add"></i> Add Agent</button>
              </div>
              <div id="dynamic-herd-config" style="display: ${herdDynamicMode ? 'block' : 'none'};">
                  <h3>Dynamic Model Pool</h3>
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

          </div>
        
          <script>
            const vscode = acquireVsCodeApi();
            const initialState = ${jsonState};
            const config = initialState.config;
            const personalities = initialState.personalities;
            let herdPre = initialState.herdPre;
            let herdPost = initialState.herdPost;
            let herdPool = initialState.herdPool;
            let loadedModels = [];
            
            // PROFILES STATE
            let profiles = config.responseProfiles || [];
            let defaultId = config.defaultResponseProfileId || 'balanced';
            let editingIndex = -1;

            function safeSet(id, value, isCheck) {
                const el = document.getElementById(id);
                if(el) {
                    if(isCheck) el.checked = !!value;
                    else el.value = (value === undefined || value === null) ? '' : value;
                }
            }

            function safeListen(id, event, callback) {
                const el = document.getElementById(id);
                if(el) el.addEventListener(event, callback);
            }

            function renderProfiles() {
                const container = document.getElementById('profiles-container');
                const selector = document.getElementById('defaultProfileSelect');
                if (!container || !selector) return;
                
                container.innerHTML = '';
                selector.innerHTML = '';

                profiles.forEach((p, idx) => {
                    // Populate Selector
                    const opt = new Option(p.name + (p.id === defaultId ? " (Default)" : ""), p.id);
                    opt.selected = p.id === defaultId;
                    selector.appendChild(opt);

                    // Populate List
                    const item = document.createElement('div');
                    item.className = 'participant-row';
                    item.innerHTML = \`
                        <div style="flex:1">
                            <strong>\${p.name}</strong> <small>(\${p.id})</small><br>
                            <span style="opacity:0.8; font-size:0.9em">\${p.description}</span>
                        </div>
                        <button id="edit-profile-\${idx}" class="icon-btn"><i class="codicon codicon-edit"></i></button>
                        <button id="del-profile-\${idx}" class="icon-btn remove-btn"><i class="codicon codicon-trash"></i></button>
                    \`;
                    container.appendChild(item);
                    
                    document.getElementById('edit-profile-'+idx).onclick = () => editProfile(idx);
                    document.getElementById('del-profile-'+idx).onclick = () => deleteProfile(idx);
                });
                
                vscode.postMessage({ command: 'updateProfiles', profiles, defaultId });
            }

            function editProfile(index) {
                editingIndex = index;
                openEditor(profiles[index]);
            }

            function deleteProfile(index) {
                if(confirm("Delete this profile?")) {
                    if (profiles[index].id === defaultId) {
                        alert("Cannot delete the default profile. Please change the default first.");
                        return;
                    }
                    profiles.splice(index, 1);
                    renderProfiles();
                }
            }

            function openEditor(p) {
                document.getElementById('p_id').value = p.id;
                document.getElementById('p_id').disabled = editingIndex !== -1;
                document.getElementById('p_name').value = p.name;
                document.getElementById('p_desc').value = p.description;
                document.getElementById('p_prefix').value = p.prefix || '';
                document.getElementById('p_prompt').value = p.systemPrompt;
                document.getElementById('profile-editor').style.display = 'block';
                document.getElementById('profiles-container').style.display = 'none';
            }

            document.getElementById('defaultProfileSelect').addEventListener('change', (e) => {
                defaultId = e.target.value;
                renderProfiles();
            });

            document.getElementById('addProfileBtn').addEventListener('click', () => {
                editingIndex = -1;
                openEditor({ id: 'new_mode', name: 'New Mode', description: '', systemPrompt: '', prefix: '' });
            });

            document.getElementById('p_cancel').addEventListener('click', () => {
                document.getElementById('profile-editor').style.display = 'none';
                document.getElementById('profiles-container').style.display = 'flex';
            });

            document.getElementById('p_save').addEventListener('click', () => {
                const newP = {
                    id: document.getElementById('p_id').value,
                    name: document.getElementById('p_name').value,
                    description: document.getElementById('p_desc').value,
                    prefix: document.getElementById('p_prefix').value,
                    systemPrompt: document.getElementById('p_prompt').value
                };

                if (!newP.id || !newP.name) {
                    alert("ID and Name are required");
                    return;
                }

                if (editingIndex === -1) {
                    if (profiles.find(x => x.id === newP.id)) {
                        alert("ID already exists");
                        return;
                    }
                    profiles.push(newP);
                } else {
                    profiles[editingIndex] = newP;
                }

                document.getElementById('profile-editor').style.display = 'none';
                document.getElementById('profiles-container').style.display = 'flex';
                renderProfiles();
            });

            document.getElementById('exportProfileBtn').addEventListener('click', () => vscode.postMessage({ command: 'exportProfiles' }));
            document.getElementById('importProfileBtn').addEventListener('click', () => vscode.postMessage({ command: 'importProfiles' }));

            function initializeForm() {
                try {
                    safeSet('apiKey', config.apiKey);
                    safeSet('apiUrl', config.apiUrl);
                    safeSet('backendType', config.backendType);
                    safeSet('useLollmsExtensions', config.useLollmsExtensions, true);
                    safeSet('requestTimeout', config.requestTimeout);
                    safeSet('agentMaxRetries', config.agentMaxRetries);
                    safeSet('maxImageSize', config.maxImageSize);
                    safeSet('disableSsl', config.disableSslVerification, true);
                    safeSet('sslCertPath', config.sslCertPath);
                    safeSet('language', config.language);
                    safeSet('autoGenerateTitle', config.autoGenerateTitle, true);
                    safeSet('addPedagogicalInstruction', config.addPedagogicalInstruction, true);
                    
                    if (config.generationFormats) {
                        safeSet('gen-full', config.generationFormats.fullFile, true);
                        safeSet('gen-diff', config.generationFormats.diff, true);
                        safeSet('gen-aider', config.generationFormats.aider, true);
                    }
                    
                    safeSet('explainCode', config.explainCode, true);
                    
                    if (config.allowedFileFormats) {
                        safeSet('fmt-fullFile', config.allowedFileFormats.fullFile, true);
                        safeSet('fmt-insert', config.allowedFileFormats.insert, true);
                        safeSet('fmt-replace', config.allowedFileFormats.replace, true);
                        safeSet('fmt-delete', config.allowedFileFormats.delete, true);
                    }
                    
                    safeSet('failsafeContextSize', config.failsafeContextSize);
                    if(document.getElementById('contextFileExceptions') && Array.isArray(config.contextFileExceptions)) 
                        document.getElementById('contextFileExceptions').value = config.contextFileExceptions.join('\\n');
                    safeSet('showOs', config.showOs, true);
                    safeSet('showIp', config.showIp, true);
                    safeSet('showShells', config.showShells, true);
                    safeSet('systemCustomInfo', config.systemCustomInfo);
                    safeSet('agentShellExecution', config.agentShellExecution, true);
                    safeSet('agentFilesystemWrite', config.agentFilesystemWrite, true);
                    safeSet('agentFilesystemRead', config.agentFilesystemRead, true);
                    safeSet('agentInternetAccess', config.agentInternetAccess, true);
                    safeSet('agentUseRLM', config.agentUseRLM, true);
                    safeSet('enableCodeInspector', config.enableCodeInspector, true);
                    safeSet('codeInspectorPersona', config.codeInspectorPersona);
                    safeSet('chatPersona', config.chatPersona);
                    safeSet('agentPersona', config.agentPersona);
                    safeSet('commitMessagePersona', config.commitMessagePersona);
                    safeSet('searchApiKey', config.searchApiKey);
                    safeSet('searchCx', config.searchCx);
                    safeSet('companionEnableWebSearch', config.companionEnableWebSearch, true);
                    safeSet('companionEnableArxivSearch', config.companionEnableArxivSearch, true);
                    safeSet('mcpServers', config.mcpServers);
                    safeSet('autoUpdateChangelog', config.autoUpdateChangelog, true);
                    safeSet('deleteBranchAfterMerge', config.deleteBranchAfterMerge, true);
                    safeSet('unstagedChangesBehavior', config.unstagedChangesBehavior);
                    safeSet('herdDynamicMode', config.herdDynamicMode, true);
                    safeSet('herdRounds', config.herdRounds);
                    safeSet('userInfoName', config.userInfoName);
                    safeSet('userInfoEmail', config.userInfoEmail);
                    safeSet('userInfoLicense', config.userInfoLicense);
                    safeSet('userInfoCodingStyle', config.userInfoCodingStyle);
                    safeSet('moltbookEnable', config.moltbookEnable, true);
                    safeSet('moltbookApiKey', config.moltbookApiKey);
                    safeSet('moltbookBotName', config.moltbookBotName);
                    safeSet('moltbookBotPurpose', config.moltbookBotPurpose);
                    
                    // Remote Settings
                    safeSet('remoteServerPort', config.remoteServerPort);
                    safeSet('remoteDiscordEnabled', config.remoteDiscordEnabled, true);
                    safeSet('remoteDiscordToken', config.remoteDiscordToken);
                    safeSet('remoteSlackEnabled', config.remoteSlackEnabled, true);
                    safeSet('remoteSlackToken', config.remoteSlackToken);
                    safeSet('remoteSlackSigningSecret', config.remoteSlackSigningSecret);
                    
                    if(document.getElementById('remoteAllowedUsers') && Array.isArray(config.remoteAllowedUsers)) 
                        document.getElementById('remoteAllowedUsers').value = config.remoteAllowedUsers.join('\\n');
                    if(document.getElementById('remoteAdminUsers') && Array.isArray(config.remoteAdminUsers)) 
                        document.getElementById('remoteAdminUsers').value = config.remoteAdminUsers.join('\\n');
                    if(document.getElementById('remoteAllowedChannels') && Array.isArray(config.remoteAllowedChannels)) 
                        document.getElementById('remoteAllowedChannels').value = config.remoteAllowedChannels.join('\\n');

                    const herdDynamic = document.getElementById('herdDynamicMode').checked;
                    document.getElementById('static-herd-config').style.display = herdDynamic ? 'none' : 'block';
                    document.getElementById('dynamic-herd-config').style.display = herdDynamic ? 'block' : 'none';
                    
                    populateModelDropdown(document.getElementById('modelSelect'), config.modelName);
                    populateModelDropdown(document.getElementById('architectModelSelect'), config.architectModelName);
                    populateModelDropdown(document.getElementById('inspectorModelName'), config.inspectorModelName);
                    renderParticipantsList('herd-pre-list', herdPre, 'herdPreAnswerParticipants');
                    renderParticipantsList('herd-post-list', herdPost, 'herdPostAnswerParticipants');
                    renderPoolList();
                    updatePersonaSelects();
                    renderProfiles(); // Init Profiles
                
                } catch(e) {
                    console.error("[WEBVIEW] Error initializing form:", e);
                }
            }

            function openTab(evt, tabName) {
                var i, tabcontent, tablinks;
                tabcontent = document.getElementsByClassName("tab-content");
                for (i = 0; i < tabcontent.length; i++) { tabcontent[i].style.display = "none"; tabcontent[i].classList.remove("active"); }
                tablinks = document.getElementsByClassName("tab-link");
                for (i = 0; i < tablinks.length; i++) { tablinks[i].className = tablinks[i].className.replace(" active", ""); }
                document.getElementById(tabName).style.display = "block";
                document.getElementById(tabName).classList.add("active");
                if(evt) evt.currentTarget.className += " active";
                else document.querySelector(".tab-link").className += " active"; 
                if (tabName === 'TabLog') vscode.postMessage({ command: 'requestLog' });
            }

            function postTempUpdate(key, value) { vscode.postMessage({ command: 'updateTempValue', key, value }); }

            function updatePersonaSelects() {
                document.querySelectorAll('.persona-select').forEach(sel => {
                    const targetId = sel.dataset.target;
                    const targetEl = document.getElementById(targetId);
                    sel.innerHTML = '<option value="">-- Select a Preset --</option>';
                    personalities.forEach(p => {
                        const opt = new Option(p.name, p.id);
                        opt.dataset.prompt = p.systemPrompt;
                        sel.appendChild(opt);
                    });
                    sel.onchange = (e) => {
                         const opt = sel.options[sel.selectedIndex];
                         if(opt && targetEl) {
                             targetEl.value = opt.dataset.prompt || '';
                             postTempUpdate(targetId, targetEl.value);
                         }
                    };
                });
            }

            function populateModelDropdown(selectElement, selectedValue, error) {
                selectElement.innerHTML = '';
                if (error) { selectElement.appendChild(new Option("Error: " + error, "")); return; }
                if (loadedModels.length > 0) {
                    if (selectElement.id === 'inspectorModelName' || selectElement.id === 'architectModelSelect') {
                        selectElement.appendChild(new Option("Same as Chat Model (Default)", ""));
                    }
                    loadedModels.forEach(model => selectElement.appendChild(new Option(model.id, model.id)));
                    if (selectedValue) selectElement.value = selectedValue;
                } else {
                    const placeholder = selectedValue ? selectedValue + " (Cached)" : "No models found";
                    selectElement.appendChild(new Option(placeholder, selectedValue));
                }
            }

            function renderParticipantsList(containerId, list, keyName) {
                const container = document.getElementById(containerId);
                container.innerHTML = '';
                list.forEach((p, index) => {
                    const row = document.createElement('div');
                    row.className = 'participant-row';
                    const modelSelect = document.createElement('select');
                    populateModelDropdown(modelSelect, p.model);
                    modelSelect.onchange = (e) => { list[index].model = e.target.value; postTempUpdate(keyName, list); };
                    const personaSelect = document.createElement('select');
                    personalities.forEach(person => personaSelect.appendChild(new Option(person.name, person.id)));
                    personaSelect.value = p.personality;
                    personaSelect.onchange = (e) => { list[index].personality = e.target.value; postTempUpdate(keyName, list); };
                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'remove-btn icon-btn';
                    removeBtn.innerHTML = '<i class="codicon codicon-trash"></i>';
                    removeBtn.onclick = () => { list.splice(index, 1); renderParticipantsList(containerId, list, keyName); postTempUpdate(keyName, list); };
                    row.appendChild(modelSelect); row.appendChild(personaSelect); row.appendChild(removeBtn);
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
                    populateModelDropdown(modelSelect, item.model);
                    modelSelect.onchange = (e) => { herdPool[index].model = e.target.value; postTempUpdate('herdDynamicModelPool', herdPool); };
                    const descInput = document.createElement('input');
                    descInput.type = 'text';
                    descInput.value = item.description || '';
                    descInput.oninput = (e) => { herdPool[index].description = e.target.value; postTempUpdate('herdDynamicModelPool', herdPool); };
                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'remove-btn icon-btn';
                    removeBtn.innerHTML = '<i class="codicon codicon-trash"></i>';
                    removeBtn.onclick = () => { herdPool.splice(index, 1); renderPoolList(); postTempUpdate('herdDynamicModelPool', herdPool); };
                    row.appendChild(modelSelect); row.appendChild(descInput); row.appendChild(removeBtn);
                    container.appendChild(row);
                });
            }

            initializeForm();
            openTab(null, 'TabApi');

            const bind = (id, key) => {
                safeListen(id, document.getElementById(id)?.type === 'checkbox' ? 'change' : 'input', () => {
                    const el = document.getElementById(id);
                    if(el) {
                        let val = el.type === 'checkbox' ? el.checked : el.value;
                        if(el.type === 'number') val = parseInt(val);
                        if(key === 'contextFileExceptions' || key === 'remoteAllowedUsers' || key === 'remoteAdminUsers' || key === 'remoteAllowedChannels') {
                            val = val.split('\\n').map(s=>s.trim()).filter(Boolean);
                        }
                        postTempUpdate(key, val);
                    }
                });
            };
            ['apiKey','apiUrl','backendType','useLollmsExtensions','requestTimeout','agentMaxRetries','maxImageSize','inspectorModelName','codeInspectorPersona','chatPersona','agentPersona','commitMessagePersona','language','failsafeContextSize','userInfoName','userInfoEmail','userInfoLicense','userInfoCodingStyle','searchApiKey','searchCx','clipboardInsertRole','herdRounds','mcpServers','unstagedChangesBehavior','systemCustomInfo','moltbookApiKey','moltbookBotName','moltbookBotPurpose',
            'remoteServerPort', 'remoteDiscordToken', 'remoteSlackToken', 'remoteSlackSigningSecret', 'remoteAllowedUsers', 'remoteAdminUsers', 'remoteAllowedChannels'].forEach(k => bind(k, k));
            
            ['disableSsl','enableCodeInspector','autoUpdateChangelog','autoGenerateTitle','addPedagogicalInstruction','companionEnableWebSearch','companionEnableArxivSearch','herdDynamicMode','enableCodeActions','enableInlineSuggestions','deleteBranchAfterMerge','showOs','showIp','showShells','agentShellExecution','agentFilesystemWrite','agentFilesystemRead','agentInternetAccess','agentUseRLM','explainCode','moltbookEnable',
            'remoteDiscordEnabled', 'remoteSlackEnabled'].forEach(id => {
                const map = { 
                    'disableSsl': 'disableSslVerification', 'deleteBranchAfterMerge': 'git.deleteBranchAfterMerge', 
                    'showOs': 'systemEnv.showOs', 'showIp': 'systemEnv.showIp', 'showShells': 'systemEnv.showShells', 
                    'systemCustomInfo': 'systemEnv.customInfo', 'moltbookEnable': 'moltbookEnable',
                    'remoteDiscordEnabled': 'remoteDiscordEnabled', 'remoteSlackEnabled': 'remoteSlackEnabled',
                    'agentUseRLM': 'agent.useRLM'
                };
                const key = map[id] || id; 
                if(id==='companionEnableWebSearch') bind(id, 'companion.enableWebSearch');
                else if(id==='companionEnableArxivSearch') bind(id, 'companion.enableArxivSearch');
                else bind(id, key);
            });

            safeListen('formatMcpBtn', 'click', () => {
                const area = document.getElementById('mcpServers');
                try {
                    const parsed = JSON.parse(area.value);
                    area.value = JSON.stringify(parsed, null, 2);
                    postTempUpdate('mcpServers', area.value);
                } catch (e) {
                    alert('Invalid JSON: ' + e.message);
                }
            });

            safeListen('unstagedChangesBehavior', 'change', (e) => {
                postTempUpdate('git.unstagedChangesBehavior', e.target.value);
            });

            safeListen('forceFullCode', 'change', (e) => {
                const val = e.target.checked;
                document.getElementById('partial-strategy-zone').style.display = val ? 'none' : 'block';
                postTempUpdate('forceFullCode', val);
            });

            safeListen('partialFormat', 'change', (e) => {
                const fmt = e.target.value;
                config.generationFormats.partialFormat = fmt;
                vscode.postMessage({ command: 'updateGenerationFormat', key: 'partialFormat', value: fmt });
            });

            safeListen('gen-full', 'change', (e) => {
                vscode.postMessage({ command: 'updateGenerationFormat', key: 'fullFile', value: e.target.checked });
            });

            ['fullFile','insert','replace','delete'].forEach(k => {
                safeListen('fmt-'+k, 'change', (e) => {
                    vscode.postMessage({ command: 'updateFormatValue', key: k, value: e.target.checked });
                });
            });

            const chatModelSelect = document.getElementById('modelSelect');
            const inspectorModelSelect = document.getElementById('inspectorModelName');
            const architectModelSelect = document.getElementById('architectModelSelect');
            
            safeListen('modelSelect', 'change', () => postTempUpdate('modelName', chatModelSelect.value));
            safeListen('inspectorModelName', 'change', () => postTempUpdate('inspectorModelName', inspectorModelSelect.value));
            safeListen('architectModelSelect', 'change', () => postTempUpdate('architectModelName', architectModelSelect.value));

            safeListen('herdDynamicMode', 'change', () => {
                 const isDynamic = document.getElementById('herdDynamicMode').checked;
                 document.getElementById('static-herd-config').style.display = isDynamic ? 'none' : 'block';
                 document.getElementById('dynamic-herd-config').style.display = isDynamic ? 'block' : 'none';
            });

            safeListen('addPreParticipantBtn', 'click', () => {
                herdPre.push({ model: config.modelName, personality: 'default_coder' });
                renderParticipantsList('herd-pre-list', herdPre, 'herdPreAnswerParticipants');
                postTempUpdate('herdPreAnswerParticipants', herdPre);
            });
            safeListen('addPostParticipantBtn', 'click', () => {
                herdPost.push({ model: config.modelName, personality: 'code_reviewer' });
                renderParticipantsList('herd-post-list', herdPost, 'herdPostAnswerParticipants');
                postTempUpdate('herdPostAnswerParticipants', herdPost);
            });
            
            safeListen('addPoolModelBtn', 'click', () => {
                herdPool.push({ model: config.modelName, description: 'General purpose model' });
                renderPoolList();
                postTempUpdate('herdDynamicModelPool', herdPool);
            });

            safeListen('refreshModels', 'click', () => refreshModelsList(true));
            safeListen('refreshInspectorModels', 'click', () => refreshModelsList(true));

            safeListen('toggleApiKey', 'click', () => {
                const input = document.getElementById('apiKey');
                const icon = document.querySelector('#toggleApiKey i');
                if (input.type === 'password') {
                    input.type = 'text';
                    icon.classList.replace('codicon-eye', 'codicon-eye-closed');
                } else {
                    input.type = 'password';
                    icon.classList.replace('codicon-eye-closed', 'codicon-eye');
                }
            });

            safeListen('copyApiKey', 'click', () => {
                const val = document.getElementById('apiKey').value;
                vscode.postMessage({ command: 'copyToClipboard', value: val });
            });

            safeListen('copyModelName', 'click', () => {
                const val = document.getElementById('modelSelect').value;
                vscode.postMessage({ command: 'copyToClipboard', value: val });
            });

            safeListen('exportConfig', 'click', () => vscode.postMessage({ command: 'exportConnectionConfig' }));
            safeListen('importConfig', 'click', () => vscode.postMessage({ command: 'importConnectionConfig' }));
            safeListen('saveToolbar', 'click', () => vscode.postMessage({ command: 'saveConfig' }));
            safeListen('resetToolbar', 'click', () => vscode.postMessage({ command: 'resetConfig' }));
            safeListen('closeToolbar', 'click', () => vscode.postMessage({ command: 'closePanel' }));
            safeListen('testConnection', 'click', () => vscode.postMessage({ command: 'testConnection' }));
            safeListen('browseCertPath', 'click', () => vscode.postMessage({ command: 'browseCertPath' }));
            safeListen('createPersonalityBtn', 'click', () => vscode.postMessage({ command: 'createPersonality' }));
            safeListen('editPromptsBtn', 'click', () => vscode.postMessage({ command: 'editPrompts' }));

            function refreshModelsList(force) {
                const loadingOption = new Option("Loading...", "");
                document.getElementById('modelSelect').innerHTML = ''; document.getElementById('modelSelect').appendChild(loadingOption.cloneNode(true));
                vscode.postMessage({ command: 'fetchModels', value: force });
            }

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'modelsList') {
                    loadedModels = message.models || [];
                    populateModelDropdown(document.getElementById('modelSelect'), config.modelName, message.error);
                    populateModelDropdown(document.getElementById('architectModelSelect'), config.architectModelName, message.error);
                    populateModelDropdown(document.getElementById('inspectorModelName'), config.inspectorModelName, message.error);
                } else if (message.command === 'refreshForm') {
                    const newConfig = message.config;
                    // Update the local script config object
                    Object.assign(config, newConfig);
                    // Re-initialize the UI fields
                    initializeForm();
                } else if (message.command === 'updateCertPath') {
                    document.getElementById('sslCertPath').value = message.path;
                    postTempUpdate('sslCertPath', message.path);
                } else if (message.command === 'logData') {
                    document.getElementById('logContent').textContent = message.content || 'No log data.';
                } else if (message.command === 'refreshProfiles') {
                    profiles = message.profiles;
                    renderProfiles();
                }
            });
          </script>
        </body>
        </html>`;
  }
}
