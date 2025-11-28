import * as vscode from 'vscode';

export interface Placeholder {
    name: string;
    fullMatch: string;
    title?: string;
    type?: 'str' | 'text' | 'int' | 'float' | 'bool';
    options?: string[];
    default?: string;
    help?: string;
}

type FormData = Record<string, string | boolean | number>;

export class PromptBuilderPanel {
    public static currentPanel: PromptBuilderPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _resolve: (value: FormData | null) => void;

    public static async createOrShow(extensionUri: vscode.Uri, placeholders: Placeholder[]): Promise<FormData | null> {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (PromptBuilderPanel.currentPanel) {
            PromptBuilderPanel.currentPanel._panel.reveal(column);
            PromptBuilderPanel.currentPanel.updateContent(placeholders);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'promptBuilder', 'Prompt Builder', column || vscode.ViewColumn.One,
                { enableScripts: true, localResourceRoots: [extensionUri] }
            );
            PromptBuilderPanel.currentPanel = new PromptBuilderPanel(panel, extensionUri, placeholders);
        }

        return new Promise<FormData | null>(resolve => {
            PromptBuilderPanel.currentPanel!._resolve = resolve;
        });
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, placeholders: Placeholder[]) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._resolve = () => {};

        this.updateContent(placeholders);
        this._setWebviewMessageListener();
        this._panel.onDidDispose(() => {
            this._resolve(null); // Resolve with null if the user closes the panel
            PromptBuilderPanel.currentPanel = undefined;
        }, null, []);
    }

    public updateContent(placeholders: Placeholder[]) {
        this._panel.webview.html = this._getHtmlForWebview(placeholders);
    }
    
    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'submitForm':
                    this._resolve(message.data);
                    this.dispose();
                    return;
                case 'cancel':
                    this._resolve(null);
                    this.dispose();
                    return;
            }
        });
    }

    public dispose() {
        this._panel.dispose();
    }

    private _getHtmlForWebview(placeholders: Placeholder[]): string {
        const formFields = placeholders.map(p => {
            const title = p.title || p.name;
            const help = p.help ? `<p class="help-text">\${p.help}</p>` : '';
            if (p.options) {
                const options = p.options.map(opt => `<option value="\${opt}" \${opt === p.default ? 'selected' : ''}>\${opt}</option>`).join('');
                return `
                    <div class="form-group">
                        <label for="\${p.name}">\${title}</label>
                        <select id="\${p.name}" name="\${p.name}">\${options}</select>
                        \${help}
                    </div>\`;
            }
            switch (p.type) {
                case 'text':
                    return \`
                        <div class="form-group">
                            <label for="\${p.name}">\${title}</label>
                            <textarea id="\${p.name}" name="\${p.name}" rows="5">\${p.default || ''}</textarea>
                            \${help}
                        </div>\`;
                case 'bool':
                    return \`
                        <div class="form-group-checkbox">
                            <label class="switch">
                                <input type="checkbox" id="\${p.name}" name="\${p.name}" \${p.default === 'true' ? 'checked' : ''}>
                                <span class="slider"></span>
                            </label>
                            <label for="\${p.name}">\${title}</label>
                             \${help}
                        </div>\`;
                default: // str, int, float
                    return \`
                        <div class="form-group">
                            <label for="\${p.name}">\${title}</label>
                            <input type="text" id="\${p.name}" name="\${p.name}" value="\${p.default || ''}">
                             \${help}
                        </div>`;
            }
        }).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prompt Builder</title>
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
        .form-content { flex-grow: 1; overflow-y: auto; padding-right: 10px; }
        h1 { font-weight: 300; text-align: center; margin-bottom: 2em; }
        .form-group { margin-bottom: 1.5em; }
        .form-group-checkbox { display: flex; align-items: center; margin-bottom: 1.5em; }
        .form-group-checkbox label:not(.switch) { margin-left: 10px; cursor: pointer; }
        label { display: block; margin-bottom: 5px; font-weight: 600; color: var(--vscode-description-foreground); }
        input[type="text"], textarea, select {
            width: 100%; padding: 8px; border: 1px solid var(--vscode-input-border);
            border-radius: 4px; background: var(--vscode-input-background);
            color: var(--vscode-input-foreground); font-size: 0.9em; box-sizing: border-box;
            font-family: var(--vscode-font-family);
        }
        textarea { resize: vertical; }
        .help-text { font-size: 0.85em; color: var(--vscode-description-foreground); margin-top: 4px; opacity: 0.8; }
        .button-group {
            display: flex; gap: 10px; margin-top: 2em;
            border-top: 1px solid var(--vscode-panel-border);
            padding-top: 1em;
        }
        button {
            flex-grow: 1; background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground); border: none; padding: 10px;
            font-size: 1em; font-weight: 600; border-radius: 4px; cursor: pointer;
            transition: background-color 0.2s ease;
        }
        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button:hover { background-color: var(--vscode-button-hoverBackground); }
        button.secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }

        /* Switch Toggle */
        .switch {
            position: relative;
            display: inline-block;
            width: 32px;
            height: 18px;
        }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider {
            position: absolute;
            cursor: pointer;
            top: 0; left: 0; right: 0; bottom: 0;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-widget-border);
            transition: .4s;
            border-radius: 18px;
        }
        .slider:before {
            position: absolute;
            content: "";
            height: 12px;
            width: 12px;
            left: 2px;
            bottom: 2px;
            background-color: var(--vscode-foreground);
            transition: .4s;
            border-radius: 50%;
        }
        input:checked + .slider {
            background-color: var(--vscode-button-background);
            border-color: var(--vscode-button-background);
        }
        input:checked + .slider:before {
            transform: translateX(14px);
            background-color: var(--vscode-button-foreground);
        }
        input:focus + .slider { outline: 1px solid var(--vscode-focusBorder); }
    </style>
</head>
<body>
    <div class="container">
        <div class="form-content">
            <h1>Prompt Builder</h1>
            <form id="builder-form">
                ${formFields}
            </form>
        </div>
        <div class="button-group">
            <button id="cancel-btn" class="secondary">Cancel</button>
            <button id="submit-btn">Insert</button>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const form = document.getElementById('builder-form');
        
        document.getElementById('submit-btn').addEventListener('click', () => {
            const formData = new FormData(form);
            const data = {};
            for (const [key, value] of formData.entries()) {
                data[key] = value;
            }
            // Handle checkboxes specifically as they might not be in FormData if unchecked
            const checkboxes = form.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => {
                data[cb.name] = cb.checked;
            });

            vscode.postMessage({ command: 'submitForm', data });
        });

        document.getElementById('cancel-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });
    </script>
</body>
</html>`;
    }
}

export function parsePlaceholders(content: string): Placeholder[] {
    const advancedRegex = /@<(\w+)>@([\s\S]*?)@<\/\1>@/g;
    const placeholders: Placeholder[] = [];
    let match;

    while ((match = advancedRegex.exec(content)) !== null) {
        const [fullMatch, name, attributes] = match;
        const placeholder: Placeholder = { name, fullMatch, type: 'str' };
        attributes.split('\n').forEach(line => {
            const [key, ...valueParts] = line.trim().split(':');
            if (key && valueParts.length > 0) {
                const value = valueParts.join(':').trim();
                switch (key) {
                    case 'title': placeholder.title = value; break;
                    case 'type': placeholder.type = value as any; break;
                    case 'options': placeholder.options = value.split(',').map(s => s.trim()); break;
                    case 'default': placeholder.default = value; break;
                    case 'help': placeholder.help = value; break;
                }
            }
        });
        placeholders.push(placeholder);
    }
    return placeholders;
}
