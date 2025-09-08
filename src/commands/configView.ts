import * as vscode from 'vscode';

export class ConfigViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'lollmsSettings.lollmsConfigView';
  private _view?: vscode.WebviewView;

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

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async message => {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        switch (message.command) {
          case 'updateApiKey':
            await config.update('apiKey', message.value, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('API key updated');
            return;
          case 'updateApiHost':
            await config.update('apiHost', message.value, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('API host updated');
            return;
        }
      },
      undefined,
      []
    );
  }

  private _getHtml(webview: vscode.Webview) {
    // Retrieve current config values on load
    const config = vscode.workspace.getConfiguration('lollmsVsCoder');
    const apiKey = config.get<string>('apiKey') || '';
    const apiHost = config.get<string>('apiHost') || 'http://localhost:9642';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Lollms Settings</title>
<style>
  body { font-family: Arial, sans-serif; padding: 10px; }
  label { display: block; margin-top: 10px; font-weight: bold; }
  input { width: 100%; padding: 5px; margin-top: 5px; }
  button { margin-top: 10px; padding: 5px 10px; }
</style>
</head>
<body>
  <label for="apiKey">API Key</label>
  <input type="text" id="apiKey" value="${apiKey}" />
  <button id="saveApiKey">Save API Key</button>

  <label for="apiHost">API Host</label>
  <input type="text" id="apiHost" value="${apiHost}" />
  <button id="saveApiHost">Save API Host</button>

  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('saveApiKey').addEventListener('click', () => {
      const value = document.getElementById('apiKey').value;
      vscode.postMessage({ command: 'updateApiKey', value });
    });

    document.getElementById('saveApiHost').addEventListener('click', () => {
      const value = document.getElementById('apiHost').value;
      vscode.postMessage({ command: 'updateApiHost', value });
    });
  </script>
</body>
</html>`;
  }
}
