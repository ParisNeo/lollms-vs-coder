import { TagPlugin, PluginContext } from '../pluginSystem.js';
import DOMPurify from 'dompurify';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

export const insightPlugin: TagPlugin = {
    id: 'record_insight',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:record_insight|add_insight)\b([^>]*?)>([\s\S]*?)<\/(?:record_insight|add_insight)>/gim,
    render: (match, context) => {
        const attrStr = match[1] || "";
        const inner = (match[2] || "").trim();

        const topicMatch = attrStr.match(/topic=["']([^"']+)["']/i);
        const topic = topicMatch ? topicMatch[1].trim() : 'Architectural Insight';

        const hashMatch = attrStr.match(/hashtags=["']([^"']+)["']/i);
        const hashtags = hashMatch ? hashMatch[1].split(',').map(h => h.trim()) : [];

        // Extract <files> block
        const filesMatch = inner.match(/<files>([\s\S]*?)<\/files>/i);
        const files = filesMatch ? filesMatch[1].split(/[\r\n,]+/).map(f => f.trim()).filter(Boolean) : [];

        // Extract <content> block or remaining body
        const contentMatch = inner.match(/<content>([\s\S]*?)<\/content>/i);
        const contentText = contentMatch ? contentMatch[1].trim() : inner.replace(/<files>[\s\S]*?<\/files>/i, '').trim();

        const blockId = `insight-card-${context.messageId}-${Date.now().toString(36)}`;
        const hashtagsHtml = hashtags.map(h => `<span class="mode-badge active" style="font-size: 9px; padding: 1px 6px; background: rgba(155, 89, 182, 0.2); color: var(--vscode-charts-purple); border-color: rgba(155, 89, 182, 0.4);">${h.startsWith('#') ? h : '#' + h}</span>`).join(' ');

        const filesHtml = files.length > 0 ? `
            <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:6px;">
                ${files.map(f => `<span style="font-family:var(--vscode-editor-font-family); font-size:10px; opacity:0.85; background:rgba(0,0,0,0.2); padding:1px 5px; border-radius:3px;"><i class="codicon codicon-file"></i> ${f}</span>`).join('')}
            </div>
        ` : '';

        return `
        <div class="file-operation-block insight-card" id="${blockId}" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1.5px solid var(--vscode-charts-purple); border-radius: 8px; margin: 12px 0; overflow: hidden; box-shadow: 0 4px 12px rgba(155, 89, 182, 0.15);">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; justify-content: space-between; font-weight: 700; font-size: 11.5px; border-bottom: 1px solid var(--vscode-widget-border);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="codicon codicon-lightbulb" style="color: var(--vscode-charts-purple); font-size: 14px;"></i>
                    <span style="color: var(--vscode-charts-purple);">${sanitizer.sanitize(topic)}</span>
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                    ${hashtagsHtml}
                    <span class="file-token-badge weight-light" style="border-color:rgba(155,89,182,0.4); color:var(--vscode-charts-purple); font-size:9px;">knowledge.ttl</span>
                </div>
            </div>
            <div class="expansion-body" style="padding: 10px 14px;">
                <div class="markdown-body" style="font-size: 11.5px; line-height: 1.45; white-space: pre-wrap;">${sanitizer.sanitize(contentText)}</div>
                ${filesHtml}
            </div>
        </div>`;
    },
    initialize: () => {}
};