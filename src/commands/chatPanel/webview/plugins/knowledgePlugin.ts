import { TagPlugin, PluginContext } from '../pluginSystem.js';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

const sanitizer = typeof DOMPurify === 'function' ? (DOMPurify as any)(window) : DOMPurify;

export const loadKnowledgePlugin: TagPlugin = {
    id: 'load_knowledge',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<load_knowledge\b[^>]*?>([\s\S]*?)<\/load_knowledge>/gim,
    render: (match, context) => {
        const sectionPath = (match[1] || "").trim();
        const blockId = `load-kn-${context.messageId}-${Date.now().toString(36)}`;

        return `
        <div class="file-operation-block load-knowledge-card" id="${blockId}" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1.5px solid var(--vscode-charts-blue); border-radius: 8px; margin: 10px 0; overflow: hidden;">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: bold; border-bottom: 1px solid var(--vscode-widget-border);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="codicon codicon-book" style="color: var(--vscode-charts-blue);"></i>
                    <span>Load Knowledge Section</span>
                </div>
                <span class="file-token-badge weight-light">[KNOWLEDGE.md]</span>
            </div>
            <div class="expansion-body" style="padding: 10px 12px; display: flex; align-items: center; justify-content: space-between;">
                <div style="font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: 600;">
                    <code>${sanitizer.sanitize(sectionPath)}</code>
                </div>
                <button type="button" class="code-action-btn apply-btn btn-trigger-load-knowledge" data-path="${sanitizer.sanitize(sectionPath)}" style="height: 24px; font-size: 10px; padding: 0 8px;">
                    <i class="codicon codicon-folder-opened"></i> Load Section
                </button>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.btn-trigger-load-knowledge').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const pathVal = (btn as HTMLElement).dataset.path;
                if (!pathVal) return;
                context.vscode.postMessage({
                    command: 'loadKnowledgeSection',
                    path: pathVal
                });
                btn.innerHTML = '<i class="codicon codicon-check"></i> Uncollapsed';
                (btn as HTMLButtonElement).disabled = true;
            };
        });
    }
};

export const updateKnowledgePlugin: TagPlugin = {
    id: 'update_knowledge',
    extractBlocks: (content: string, context: PluginContext) => {
        const results: { match: any, start: number, end: number, html: string }[] = [];
        const regex = /^[ \t]*<update_knowledge\b([^>]*?)>([\s\S]*?)(?:<\/update_knowledge>|$)/gim;
        let match;
        while ((match = regex.exec(content)) !== null) {
            const fullMatch = match[0];
            const html = updateKnowledgePlugin.render(match, context);
            if (html) {
                results.push({
                    match,
                    start: match.index,
                    end: match.index + fullMatch.length,
                    html
                });
            }
        }
        return results;
    },
    render: (match, context) => {
        const attrStr = match[1] || "";
        const rawContent = (match[2] || "").trim();
        const pathMatch = attrStr.match(/path=["']([^"']+)["']/i);
        const sectionPath = pathMatch ? pathMatch[1].trim() : "";

        const isClosed = match[0].includes('</update_knowledge>');
        const isStreaming = !context.isFinal && !isClosed;
        const blockId = `update-kn-${context.messageId}-${Date.now().toString(36)}`;

        let previewHtml = "";
        try {
            previewHtml = `<div class="markdown-body" style="font-size:11.5px; line-height:1.45; max-height:240px; overflow-y:auto; padding:8px 10px; background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border); border-radius:4px;">${sanitizer.sanitize(marked.parse(rawContent) as string)}</div>`;
        } catch {
            previewHtml = `<pre style="margin:0; padding:8px; font-size:11px; white-space:pre-wrap;">${rawContent}</pre>`;
        }

        const encodedContent = encodeURIComponent(rawContent);

        return `
        <div class="file-operation-block update-knowledge-card" id="${blockId}" style="background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1.5px solid var(--vscode-charts-orange); border-radius: 8px; margin: 12px 0; overflow: hidden;">
            <div class="file-operation-header" style="padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--vscode-widget-border);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="codicon codicon-book" style="color: var(--vscode-charts-orange); font-size: 14px;"></i>
                    <span>Knowledge Update: <code>${sanitizer.sanitize(sectionPath || 'root')}</code></span>
                </div>
                <div style="display: flex; align-items: center; gap: 6px; font-size: 11px;">
                    ${isStreaming ? '<span class="spinner" style="width:10px; height:10px; border-width:2px;"></span> Writing...' : '<i class="codicon codicon-check" style="color:var(--vscode-charts-green)"></i> Saved'}
                </div>
            </div>
            <div class="expansion-body" style="padding: 10px 12px;">
                ${previewHtml}
                <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;">
                    <button type="button" class="code-action-btn secondary-btn btn-copy-kn" data-content="${encodedContent}" style="height: 22px; font-size: 10px; padding: 0 8px;">
                        <i class="codicon codicon-copy"></i> Copy
                    </button>
                    <button type="button" class="code-action-btn secondary-btn btn-open-kn" data-path="${sanitizer.sanitize(sectionPath)}" style="height: 22px; font-size: 10px; padding: 0 8px;">
                        <i class="codicon codicon-file"></i> Open KNOWLEDGE.md
                    </button>
                </div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.btn-copy-kn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const content = decodeURIComponent((btn as HTMLElement).dataset.content || '');
                if (content) {
                    context.vscode.postMessage({ command: 'copyToClipboard', text: content });
                }
            };
        });

        container.querySelectorAll('.btn-open-kn').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.stopPropagation();
                const secPath = (btn as HTMLElement).dataset.path || '';
                const targetPath = secPath ? `.lollms/knowledge/${secPath}/KNOWLEDGE.md` : `.lollms/KNOWLEDGE.md`;
                context.vscode.postMessage({ command: 'openFile', path: targetPath });
            };
        });
    }
};