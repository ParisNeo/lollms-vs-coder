import * as vscode from 'vscode';

export class ConfigViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'lollmsSettings.lollmsConfigView';
  private _view?: vscode.WebviewView;

  private _pendingConfig = {
    apiKey: '',
    apiUrl: '',
    modelName: ''
  };

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    // Load current config values
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    this._pendingConfig.apiKey = config.get<string>('apiKey')?.trim() || '';
    this._pendingConfig.apiUrl = config.get<string>('apiUrl') || 'http://localhost:9642';
    this._pendingConfig.modelName = config.get<string>('modelName') || '';

    webviewView.webview.html = this._getHtml(webviewView.webview, this._pendingConfig);

    webviewView.webview.onDidReceiveMessage(
      async (message: { command: string; key?: string; value?: string }) => {
        switch (message.command) {
          case 'updateTempValue':
            if (message.key === 'apiKey' || message.key === 'apiUrl' || message.key === 'modelName') {
              this._pendingConfig[message.key] = message.value || '';
            }
            return;

          case 'saveConfig':
            try {
              const config = vscode.workspace.getConfiguration('lollmsVsCoder');
              await config.update('apiKey', this._pendingConfig.apiKey, vscode.ConfigurationTarget.Global);
              await config.update('apiUrl', this._pendingConfig.apiUrl, vscode.ConfigurationTarget.Global);
              await config.update('modelName', this._pendingConfig.modelName, vscode.ConfigurationTarget.Global);

              vscode.window.showInformationMessage('Configuration saved. Recreating LollmsAPI...');
              await vscode.commands.executeCommand('lollmsApi.recreateClient', this._pendingConfig);
            } catch (err) {
              vscode.window.showErrorMessage('Failed to save configuration.');
              console.error(err);
            }
            return;

          case 'fetchModels':
            if (this._view && this._pendingConfig.apiUrl && this._pendingConfig.apiKey) {
              try {
                const models: Array<{ id: string }> | undefined = await vscode.commands.executeCommand(
                  'lollmsSettings.fetchModels',
                  this._pendingConfig.apiUrl,
                  this._pendingConfig.apiKey
                );
                this._view.webview.postMessage({ command: 'modelsList', models: models || [] });
              } catch (e) {
                console.error('Error fetching models:', e);
                this._view.webview.postMessage({ command: 'modelsList', models: [] });
              }
            }
            return;
        }
      },
      undefined,
      []
    );
  }

  private _getHtml(webview: vscode.Webview, config: { apiKey: string; apiUrl: string; modelName: string }) {
    const escapeHtml = (unsafe: string) =>
      unsafe.replace(/[&<>"'`=\/]/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '`': '&#96;',
        '=': '&#61;',
        '/': '&#x2F;',
      }[c] || c));

    const apiKey = escapeHtml(config.apiKey);
    const apiUrl = escapeHtml(config.apiUrl);
    const modelName = escapeHtml(config.modelName);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lollms Configuration</title>
<style>
  body {
    font-family: Arial, sans-serif;
    padding: 20px;
    margin: 0;
    height: 100vh;
    box-sizing: border-box;
    background: #fff;
    color: #333;
  }
  .container {
    max-width: 420px;
    margin: auto;
    padding: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  h1 {
    margin-bottom: 24px;
    font-weight: 700;
    font-size: 1.6em;
    color: #222;
  }
  label {
    margin-top: 24px;
    margin-bottom: 8px;
    font-weight: 600;
    color: #555;
    display: block;
  }
  input[type="text"], input[list] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
    background: #f9f9f9;
    font-size: 1em;
    box-sizing: border-box;
    transition: border-color 0.2s ease;
  }
  input[type="text"]:focus, input[list]:focus {
    outline: none;
    border-color: #007acc;
    background: #fff;
    box-shadow: none;
  }
  .form-scroll {
    overflow-y: auto;
    flex-grow: 1;
    padding-right: 8px;
    margin-bottom: 15px;
  }
  button {
    background-color: #007acc;
    color: white;
    border: none;
    padding: 14px;
    font-size: 1em;
    font-weight: 700;
    border-radius: 4px;
    cursor: pointer;
    margin-top: 32px;
    transition: background-color 0.3s ease;
    user-select: none;
    box-shadow: none;
  }
  button:hover {
    background-color: #005a9e;
  }
  #refreshModels {
    margin-top: 8px;
    padding: 6px 12px;
    font-size: 0.9em;
    border-radius: 4px;
    border: 1px solid #007acc;
    background: #fff;
    color: #007acc;
    cursor: pointer;
  }
  #refreshModels:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
</head>
<body>
  <div class="container">
    <h1>Lollms Configuration</h1>
    <div class="form-scroll" tabindex="0">
      <label for="apiKey">API Key</label>
      <input type="text" id="apiKey" value="${apiKey}" placeholder="Enter your API key" autocomplete="off" />

      <label for="apiUrl">API Host</label>
      <input type="text" id="apiUrl" value="${apiUrl}" placeholder="http://localhost:9642" autocomplete="off" />

      <label for="modelSelect">Model</label>
      <input list="modelsList" id="modelSelect" name="modelSelect" value="${modelName}" placeholder="Enter or select model" autocomplete="off" />
      <datalist id="modelsList"></datalist>
      <button id="refreshModels" type="button">Refresh Models List</button>
    </div>

    <button id="saveConfig">Save Configuration</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const apiKeyInput = document.getElementById('apiKey');
    const apiUrlInput = document.getElementById('apiUrl');
    const modelInput = document.getElementById('modelSelect');
    const modelsDatalist = document.getElementById('modelsList');
    const refreshBtn = document.getElementById('refreshModels');

    let pendingConfig = {
      apiKey: ${JSON.stringify(apiKey)},
      apiUrl: ${JSON.stringify(apiUrl)},
      modelName: ${JSON.stringify(modelName)}
    };

    function requestModels() {
      vscode.postMessage({ command: 'fetchModels' });
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing...';
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'modelsList' && Array.isArray(message.models)) {
        modelsDatalist.innerHTML = message.models.map(m => '<option value="' + m.id + '"></option>').join('');
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh Models List';
      }
    });

    apiKeyInput.addEventListener('input', e => {
      pendingConfig.apiKey = e.target.value;
      vscode.postMessage({ command: 'updateTempValue', key: 'apiKey', value: pendingConfig.apiKey });
      requestModels();
    });

    apiUrlInput.addEventListener('input', e => {
      pendingConfig.apiUrl = e.target.value;
      vscode.postMessage({ command: 'updateTempValue', key: 'apiUrl', value: pendingConfig.apiUrl });
      requestModels();
    });

    modelInput.addEventListener('input', e => {
      pendingConfig.modelName = e.target.value;
      vscode.postMessage({ command: 'updateTempValue', key: 'modelName', value: pendingConfig.modelName });
    });

    refreshBtn.addEventListener('click', () => {
      requestModels();
    });

    document.getElementById('saveConfig').addEventListener('click', () => {
      vscode.postMessage({ command: 'saveConfig' });
    });

    window.addEventListener('load', () => {
      if (pendingConfig.apiKey && pendingConfig.apiUrl) {
        requestModels();
      }
    });
  </script>
</body>
</html>`;
  }
}
