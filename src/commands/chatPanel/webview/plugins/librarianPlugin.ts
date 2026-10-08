import { TagPlugin, PluginContext } from '../pluginSystem.js';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

export const librarianPlugin: TagPlugin = {
    id: 'librarian_tag',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:librarian|ask_librarian|consult_librarian|governor|ask_governor)\b([^>]*?)>([\s\S]*?)<\/(?:librarian|ask_librarian|consult_librarian|governor|ask_governor)>/gim,
    render: (match, context) => {
        const content = (match[2] || "").trim();
        const escaped = content
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        const blockId = `lib-req-${context.messageId}-${Math.random().toString(36).substring(7)}`;

        return `
        <div class="governor-directive-card librarian-consultation-card" id="${blockId}" data-query="${encodeURIComponent(content)}" style="margin: 10px 0; padding: 10px 12px; background: rgba(0, 122, 204, 0.08); border: 1px solid var(--vscode-widget-border); border-left: 4px solid var(--vscode-charts-blue); border-radius: 6px; font-size: 11.5px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <span style="display: flex; align-items: center; gap: 6px; font-weight: 700; color: var(--vscode-charts-blue); text-transform: uppercase; font-size: 10.5px;">
                    <i class="codicon codicon-search"></i> Automated Codebase Discovery (Stage 1)
                </span>
                <span style="font-size: 10px; color: var(--vscode-charts-green);"><i class="codicon codicon-pass-filled"></i> Autonomous</span>
            </div>
            <div style="opacity: 0.9; line-height: 1.45; white-space: pre-wrap; font-family: var(--vscode-font-family);">${escaped}</div>
        </div>`;
    },
    initialize: () => {
        // Fully autonomous: zero button clicks required from the user
    }
};



export default librarianPlugin;