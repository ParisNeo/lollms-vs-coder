import * as vscode from 'vscode';

export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  
  private _pendingConfig = {
    apiKey: '',
    apiUrl: '',
    modelName: '',
    disableSslVerification: false
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
  
                vscode.window.showInformationMessage('Configuration saved. Recreating LollmsAPI...');
                await vscode.commands.executeCommand('lollmsApi.recreateClient', this._pendingConfig);
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
                    this._pendingConfig.apiKey
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

  private _getHtml(webview: vscode.Webview, config: { apiKey: string; apiUrl: string; modelName: string, disableSslVerification: boolean }) {
    const { apiKey, apiUrl, modelName, disableSslVerification } = config;

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
                display: flex; flex-direction: column; max-width: 600px; margin: 0 auto;
              }
              .form-content { flex-grow: 1; overflow-y: auto; }
              h1 { font-weight: 300; text-align: center; margin-bottom: 2em; }
              h2 { font-weight: 400; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 5px; margin-top: 2em; }
              label { display: block; margin-top: 14px; margin-bottom: 5px; font-weight: 600; font-size: 0.9em; color: var(--vscode-description-foreground); }
              input[type="text"], input[list] {
                width: 100%; padding: 8px; border: 1px solid var(--vscode-input-border);
                border-radius: 4px; background: var(--vscode-input-background);
                color: var(--vscode-input-foreground); font-size: 0.9em; box-sizing: border-box;
              }
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
              .help-text { font-size: 0.9em; color: var(--vscode-description-foreground); opacity: 0.9; }
              .checkbox-container { display: flex; align-items: center; margin-top: 1em; }
              .checkbox-container input { margin-right: 0.5em; }
            </style>
        </head>
        <body>
          <div class="container">
            <div class="form-content">
              <h1>Lollms VS Coder Settings</h1>
              
              <h2>API Configuration</h2>
              <label for="apiKey">API Key</label>
              <input type="text" id="apiKey" value="${apiKey}" placeholder="Enter your Lollms API key" autocomplete="off" />
              <label for="apiUrl">API Host</label>
              <input type="text" id="apiUrl" value="${apiUrl}" placeholder="http://localhost:9642" autocomplete="off" />
              <label for="modelSelect">Model</label>
              <input list="modelsList" id="modelSelect" name="modelSelect" value="${modelName}" placeholder="Enter or select a model" autocomplete="off" />
              <datalist id="modelsList"></datalist>
              <button id="refreshModels" type="button" class="secondary-button">Refresh Models</button>

              <div class="checkbox-container">
                  <input type="checkbox" id="disableSsl" ${disableSslVerification ? 'checked' : ''}>
                  <label for="disableSsl">Disable SSL Verification</label>
              </div>
              <p class="help-text">Useful for local servers with self-signed certificates.</p>

              <h2>Advanced</h2>
              <p class="help-text">For advanced customization, you can directly edit the JSON file that stores your prompt library.</p>
              <button id="editPromptsBtn" class="secondary-button">Edit Prompts JSON</button>
            </div>
            <button id="saveConfig">Save & Close</button>
          </div>
        
          <script>
            const vscode = acquireVsCodeApi();
            
            window.addEventListener('DOMContentLoaded', () => {
                const apiKeyInput = document.getElementById('apiKey');
                const apiUrlInput = document.getElementById('apiUrl');
                const modelSelectInput = document.getElementById('modelSelect');
                const modelsDatalist = document.getElementById('modelsList');
                const disableSslCheckbox = document.getElementById('disableSsl');

                function postTempUpdate(key, value) {
                  vscode.postMessage({ command: 'updateTempValue', key, value });
                }

                apiKeyInput.addEventListener('input', e => postTempUpdate('apiKey', e.target.value));
                apiUrlInput.addEventListener('input', e => postTempUpdate('apiUrl', e.target.value));
                modelSelectInput.addEventListener('input', e => postTempUpdate('modelName', e.target.value));
                disableSslCheckbox.addEventListener('change', e => postTempUpdate('disableSslVerification', e.target.checked));
                
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