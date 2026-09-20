import { TagPlugin } from '../pluginSystem.js';

export const governorPlugin: TagPlugin = {
    id: 'governor_tag',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<governor\b([^>]*?)>([\s\S]*?)<\/governor>/gim,
    render: (match) => {
        const content = (match[2] || "").trim();
        const escaped = content
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        return `
        <div class="governor-directive-card" style="margin: 8px 0; padding: 8px 12px; background: rgba(214, 122, 13, 0.08); border: 1px solid var(--vscode-widget-border); border-left: 3px solid var(--vscode-charts-orange); border-radius: 6px; font-size: 11px;">
            <div style="display: flex; align-items: center; gap: 6px; font-weight: bold; color: var(--vscode-charts-orange); margin-bottom: 4px; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px;">
                <i class="codicon codicon-law"></i> Governor Directive (Seen Only by Governor)
            </div>
            <div style="opacity: 0.9; line-height: 1.4; white-space: pre-wrap; font-family: var(--vscode-font-family);">${escaped}</div>
        </div>`;
    }
};

export default governorPlugin;