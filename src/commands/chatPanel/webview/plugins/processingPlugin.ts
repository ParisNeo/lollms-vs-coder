import { TagPlugin } from '../pluginSystem';

export const processingPlugin: TagPlugin = {
    id: 'processing',
    tagPattern: /<processing\b[^>]*>([\s\S]*?)(?:<\/processing>|$)/gi,
    render: (match, context) => {
        const content = match[1].trim();
        const isClosed = match[0].toLowerCase().includes('</processing>');
        const lines = content.split('\n').filter(l => l.trim());
        const title = lines.length > 0 ? lines[lines.length - 1].replace(/^\*\s*/, '') : "Processing...";
        
        return `
        <div class="processing-block">
            <details ${!isClosed ? 'open' : ''}>
                <summary class="processing-header">
                    <span class="folder-handle codicon"></span>
                    ${isClosed ? '<i class="codicon codicon-check" style="color:var(--vscode-charts-green)"></i>' : '<div class="spinner"></div>'}
                    <span class="processing-title">${title}</span>
                </summary>
                <div class="processing-body">${content}</div>
            </details>
        </div>`;
    }
};