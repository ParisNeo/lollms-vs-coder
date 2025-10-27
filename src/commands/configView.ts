import * as vscode from 'vscode';

export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  
  private _pendingConfig = {
    apiKey: '',
    apiUrl: '',
    modelName: '',
    disableSslVerification: false,
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
    thinkingModeCustomPrompt: ''
  };

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'lollmsSettingsPanel',
      'Lollms Settings',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri]
      }
    );

    SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    this._pendingConfig.apiKey = config.get<string>('apiKey')?.trim() || '';
    this._pendingConfig.apiUrl = config.get<string>('apiUrl') || 'http://localhost:9642';
    this._pendingConfig.modelName = config.get<string>('modelName') || '';
    this._pendingConfig.disableSslVerification = config.get<boolean>('disableSslVerification') || false;
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
  
            case 'saveConfig':
              try {
                const config = vscode.workspace.getConfiguration('lollmsVsCoder');
                await config.update('apiKey', this._pendingConfig.apiKey, vscode.ConfigurationTarget.Global);
                await config.update('apiUrl', this._pendingConfig.apiUrl, vscode.ConfigurationTarget.Global);
                await config.update('modelName', this._pendingConfig.modelName, vscode.ConfigurationTarget.Global);
                await config.update('disableSslVerification', this._pendingConfig.disableSslVerification, vscode.ConfigurationTarget.Global);
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
  
                vscode.window.showInformationMessage('Configuration saved. Recreating LollmsAPI...');
                await vscode.commands.executeCommand('lollmsApi.recreateClient');
                SettingsPanel.currentPanel?.dispose();
              } catch (err) {
                vscode.window.showErrorMessage('Failed to save configuration.');
                console.error(err);
              }
              return;
  
            case 'fetchModels':
              if (this._panel && this._pendingConfig.apiUrl) {
                try {
                  const models: Array<{ id: string }> | undefined = await vscode.commands.executeCommand(
                    'lollmsSettings.fetchModels',
                    this._pendingConfig.apiUrl,
                    this._pendingConfig.apiKey,
                    this._pendingConfig.disableSslVerification
                  );
                  this._panel.webview.postMessage({ command: 'modelsList', models: models || [] });
                } catch (e) {
                  console.error('Error fetching models:', e);
                  this._panel.webview.postMessage({ command: 'modelsList', models: [] });
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
    const { apiKey, apiUrl, modelName, disableSslVerification, noThinkMode, requestTimeout, agentMaxRetries, maxImageSize, enableCodeInspector, inspectorModelName, codeInspectorPersona, chatPersona, agentPersona, commitMessagePersona, contextFileExceptions, fileUpdateMethod, language, thinkingMode, thinkingModeCustomPrompt } = config;

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Lollms Configuration</title>
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
            </style>
        </head>
        <body>
          <div class="container">
            <div class="form-content">
              <h1>Lollms VS Coder Settings</h1>

              <h2>General</h2>
              <label for="language">Language</label>
              <select id="language">
                <option value="auto" ${language === 'auto' ? 'selected' : ''}>Automatic (Follow VS Code)</option>
                <option value="en" ${language === 'en' ? 'selected' : ''}>English</option>
                <option value="fr" ${language === 'fr' ? 'selected' : ''}>French</option>
                <option value="es" ${language === 'es' ? 'selected' : ''}>Spanish</option>
                <option value="de" ${language === 'de' ? 'selected' : ''}>German</option>
                <option value="zh-cn" ${language === 'zh-cn' ? 'selected' : ''}>Chinese, Simplified</option>
                <option value="ar" ${language === 'ar' ? 'selected' : ''}>Arabic</option>
              </select>
              <p class="help-text">Influences the AI's response language. The extension UI follows VS Code's display language setting.</p>
              
              <h2>API & Model</h2>
              <label for="thinkingMode">Thinking Mode</label>
              <select id="thinkingMode">
                <option value="none" ${thinkingMode === 'none' ? 'selected' : ''}>None (Default)</option>
                <option value="chain_of_thought" ${thinkingMode === 'chain_of_thought' ? 'selected' : ''}>Chain of Thought</option>
                <option value="plan_and_solve" ${thinkingMode === 'plan_and_solve' ? 'selected' : ''}>Plan and Solve</option>
                <option value="self_critique" ${thinkingMode === 'self_critique' ? 'selected' : ''}>Self-Critique</option>
                <option value="custom" ${thinkingMode === 'custom' ? 'selected' : ''}>Custom</option>
              </select>
              <p class="help-text">Select a structured thinking technique for the AI to improve complex responses.</p>
              <div id="custom-thinking-prompt-container" style="display: ${thinkingMode === 'custom' ? 'block' : 'none'};">
                <label for="thinkingModeCustomPrompt">Custom Thinking Prompt</label>
                <textarea id="thinkingModeCustomPrompt" rows="4">${thinkingModeCustomPrompt}</textarea>
                <p class="help-text">Your custom instruction for the AI's thinking process. Used when 'Thinking Mode' is set to 'Custom'.</p>
              </div>
              <label for="apiUrl">API Host</label>
              <input type="text" id="apiUrl" value="${apiUrl}" placeholder="http://localhost:9642" autocomplete="off" />
              <label for="apiKey">API Key</label>
              <input type="text" id="apiKey" value="${apiKey}" placeholder="Enter your Lollms API key" autocomplete="off" />
              <label for="modelSelect">Model</label>
              <input list="modelsList" id="modelSelect" name="modelSelect" value="${modelName}" placeholder="Enter or select a model" autocomplete="off" />
              <datalist id="modelsList"></datalist>
              <button id="refreshModels" type="button" class="secondary-button">Refresh Models</button>
              <label for="requestTimeout">Request Timeout (ms)</label>
              <input type="number" id="requestTimeout" value="${requestTimeout}" min="1000" step="1000" />
              <p class="help-text">Increase this if large generations are timing out. Default is 600000 (10 minutes).</p>
              <div class="checkbox-container">
                  <input type="checkbox" id="disableSsl" ${disableSslVerification ? 'checked' : ''}>
                  <label for="disableSsl">Disable SSL Verification</label>
              </div>
              <p class="help-text">Useful for local servers with self-signed certificates.</p>
              <div class="checkbox-container">
                  <input type="checkbox" id="noThinkMode" ${noThinkMode ? 'checked' : ''}>
                  <label for="noThinkMode">Enable /no_think Mode</label>
              </div>
              <p class="help-text">Prefixes all system prompts with the /no_think command for models that support it.</p>
              
              <h2>Context & File Strategy</h2>
              <label for="fileUpdateMethod">File Update Method</label>
              <select id="fileUpdateMethod">
                <option value="full_file" ${fileUpdateMethod === 'full_file' ? 'selected' : ''}>Full File Content</option>
                <option value="patch" ${fileUpdateMethod === 'patch' ? 'selected' : ''}>Diff Patch</option>
              </select>
              <p class="help-text">Choose how the AI provides file updates. 'Full File' is more reliable; 'Patch' uses fewer tokens.</p>
              <label for="maxImageSize">Max Image Size (px)</label>
              <input type="number" id="maxImageSize" value="${maxImageSize}" min="0" step="128" />
              <p class="help-text">Resize images to this maximum dimension before sending. 0 disables resizing.</p>
              <label for="contextFileExceptions">Context File Exceptions</label>
              <textarea id="contextFileExceptions" rows="8">${contextFileExceptions.join('\n')}</textarea>
              <p class="help-text">Enter file or folder patterns to always exclude from the AI context, one pattern per line. Uses glob patterns (e.g., '*.log', 'dist/**').</p>

              <h2>Agent & Inspector</h2>
              <label for="agentMaxRetries">Agent Self-Correction Retries</label>
              <input type="number" id="agentMaxRetries" value="${agentMaxRetries}" min="0" max="5" />
              <p class="help-text">Number of times the agent will try to fix a failed task before asking for help.</p>
              <div class="checkbox-container">
                  <input type="checkbox" id="enableCodeInspector" ${enableCodeInspector ? 'checked' : ''}>
                  <label for="enableCodeInspector">Enable Code Inspector</label>
              </div>
              <p class="help-text">Adds a button to AI-generated code blocks to check for bugs and vulnerabilities.</p>
              <label for="inspectorModelName">Inspector Model Name</label>
              <input type="text" id="inspectorModelName" value="${inspectorModelName}" placeholder="Default: Same as chat model" autocomplete="off" />
              <p class="help-text">Optional. Use a different, potentially stronger model for code inspection.</p>

              <h2>Personas / System Prompts</h2>
              <label for="chatPersona">Chat Mode Persona</label>
              <textarea id="chatPersona" rows="6" placeholder="e.g., You are a helpful AI assistant.">${chatPersona}</textarea>
              <p class="help-text">Define the AI's persona and rules for the main chat. Supports placeholders: <code>{{date}}</code>, <code>{{os}}</code>.</p>
              <label for="agentPersona">Agent Mode Persona</label>
              <textarea id="agentPersona" rows="4" placeholder="e.g., You are a sub-agent that follows instructions.">${agentPersona}</textarea>
              <p class="help-text">Define the persona for AI agents performing autonomous tasks. Supports placeholders: <code>{{date}}</code>, <code>{{os}}</code>.</p>
              <label for="codeInspectorPersona">Code Inspector Persona</label>
              <textarea id="codeInspectorPersona" rows="4">${codeInspectorPersona}</textarea>
              <p class="help-text">Customize the persona of the code inspector.</p>
              <label for="commitMessagePersona">Git Commit Persona</label>
              <textarea id="commitMessagePersona" rows="4" placeholder="e.g., You are an expert at writing conventional git commit messages.">${commitMessagePersona}</textarea>
              <p class="help-text">Define the persona for the git commit message generator.</p>

              <h2>Advanced</h2>
              <p class="help-text">For advanced customization, you can directly edit the JSON file that stores your prompt library.</p>
              <button id="editPromptsBtn" class="secondary-button">Edit Prompts JSON</button>
            </div>
            <button id="saveConfig">Save & Close</button>
          </div>
        
          <script>
            const vscode = acquireVsCodeApi();
            
            window.addEventListener('DOMContentLoaded', () => {
                const fields = {
                    language: document.getElementById('language'),
                    apiKey: document.getElementById('apiKey'),
                    apiUrl: document.getElementById('apiUrl'),
                    modelName: document.getElementById('modelSelect'),
                    requestTimeout: document.getElementById('requestTimeout'),
                    disableSslVerification: document.getElementById('disableSsl'),
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
                    thinkingModeCustomPrompt: document.getElementById('thinkingModeCustomPrompt')
                };
                
                const modelsDatalist = document.getElementById('modelsList');
                const customThinkingPromptContainer = document.getElementById('custom-thinking-prompt-container');

                fields.thinkingMode.addEventListener('change', () => {
                    customThinkingPromptContainer.style.display = fields.thinkingMode.value === 'custom' ? 'block' : 'none';
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
                
                document.getElementById('refreshModels').addEventListener('click', () => {
                  modelsDatalist.innerHTML = '';
                  const loadingOption = document.createElement('option');
                  loadingOption.value = "Loading...";
                  modelsDatalist.appendChild(loadingOption);
                  vscode.postMessage({ command: 'fetchModels' })
                });

                document.getElementById('editPromptsBtn').addEventListener('click', () => vscode.postMessage({ command: 'editPrompts' }));
                document.getElementById('saveConfig').addEventListener('click', () => vscode.postMessage({ command: 'saveConfig' }));

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'modelsList') {
                        modelsDatalist.innerHTML = '';
                        if (Array.isArray(message.models) && message.models.length > 0) {
                            message.models.forEach(model => {
                                const option = document.createElement('option');
                                option.value = model.id;
                                modelsDatalist.appendChild(option);
                            });
                        } else {
                            const noModelsOption = document.createElement('option');
                            noModelsOption.value = "No models found or failed to fetch.";
                            modelsDatalist.appendChild(noModelsOption);
                        }
                    }
                });
            });
          </script>
        </body>
        </html>`;
  }
}