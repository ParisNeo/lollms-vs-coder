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
                            <input type="checkbox" id="\${p.name}" name="\${p.name}" \${p.default === 'true' ? 'checked' : ''}>
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

        return `<!DOCTYPE html>...`; // Full HTML in next step
    }
}

export function parsePlaceholders(content: string): Placeholder[] {
    const advancedRegex = /@<(\w+)>@([\s\S]*?)@<\/\1>@/g;
    const placeholders: Placeholder[] = [];
    let match;

    while ((match = advancedRegex.exec(content)) !== null) {
        const [fullMatch, name, attributes] = match;
        const placeholder: Placeholder = { name, fullMatch, type: 'str' };
        attributes.split('\\n').forEach(line => {
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