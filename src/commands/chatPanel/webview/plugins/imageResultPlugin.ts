import { TagPlugin } from '../pluginSystem';

export const imageResultPlugin: TagPlugin = {
    id: 'image_result',
    tagPattern: /<image_result\s+path=["']([^"']*)["']\s*\/>/gi,
    render: (match, context) => {
        const path = match[1];
        const id = `img-res-${context.messageId}-${Math.random().toString(36).substring(7)}`;

        // Request URI resolution from extension immediately
        setTimeout(() => {
            context.vscode.postMessage({ command: 'resolveImageUri', path, targetId: id });
        }, 0);

        return `
        <div class="generation-block">
            <div class="generation-header">
                <span class="summary-lang-label"><span class="codicon codicon-file-media"></span> Local Asset: ${path}</span>
            </div>
            <div id="${id}" style="display:flex; justify-content:center; background: #000; padding: 10px; min-height: 50px;">
                <div class="spinner"></div>
            </div>
        </div>`;
    }
};