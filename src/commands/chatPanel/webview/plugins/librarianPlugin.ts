import { TagPlugin, PluginContext } from '../pluginSystem.js';
import DOMPurify from 'dompurify';

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
        <div class="governor-directive-card librarian-consultation-card" id="${blockId}" data-query="${encodeURIComponent(content)}" style="margin: 10px 0; padding: 10px 14px; background: rgba(214, 122, 13, 0.08); border: 1.5px solid var(--vscode-charts-orange); border-radius: 8px; font-size: 11.5px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <span style="display: flex; align-items: center; gap: 6px; font-weight: 700; color: var(--vscode-charts-orange); text-transform: uppercase; font-size: 11px;">
                    <i class="codicon codicon-library"></i> Librarian Session Dispatched (AI Debate)
                </span>
                <span style="font-size: 10px; color: var(--vscode-charts-green); font-weight: bold;"><i class="codicon codicon-sync spin"></i> Scouting Codebase</span>
            </div>
            <div style="opacity: 0.95; line-height: 1.45; white-space: pre-wrap; font-family: var(--vscode-font-family);">${escaped}</div>
        </div>`;
    },
    initialize: () => {}
};

export const librarianOffPlugin: TagPlugin = {
    id: 'librarian_off_tag',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<librarian_off\b([^>]*?)>([\s\S]*?)<\/librarian_off>|(?:^[ \t]*|(?<=>)[ \t]*)<librarian_off\s*(?:\/|>[\s\S]*?<\/librarian_off)>/gim,
    render: (match, _context) => {
        const inner = (match[2] || "").trim();
        const files = inner.split(/[\r\n,]+/).map(f => f.trim().replace(/^['"`]|['"`]$/g, '')).filter(f => f && !f.startsWith('<'));
        const filesBadge = files.length > 0 
            ? ` · Verified Target Files: [${files.map(f => `<code>${f.split('/').pop()}</code>`).join(', ')}]`
            : '';
        return `
        <div class="librarian-off-badge" style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 12px; background: rgba(46, 204, 113, 0.12); border: 1px solid var(--vscode-charts-green); color: var(--vscode-charts-green); font-size: 11px; font-weight: bold; margin: 8px 0;">
            <i class="codicon codicon-pass-filled"></i> <span>Librarian Session Concluded · Grounding Verified${filesBadge}</span>
        </div>`;
    },
    initialize: () => {}
};

export default librarianPlugin;