import { TagPlugin } from '../pluginSystem';

export const projectMemoryPlugin: TagPlugin = {
    id: 'project_memory',
    tagPattern: /<project_memory\s+([^>]*?)>([\s\S]*?)<\/project_memory>/gi,
    render: (match, context) => {
        const attrStr = match[1];
        const content = match[2].trim();
        const attrs: any = {};
        attrStr.replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => (attrs[k] = v, ''));

        const action = attrs.action || 'add';
        const id = attrs.id;
        const title = attrs.title || id;

        if (action === 'delete') {
            return `
            <div class="project-memory-block memory-deleted" data-mem-id="${id}">
                <div class="memory-summary" style="padding: 10px;">
                    <span class="codicon codicon-trash" style="color:var(--vscode-charts-red)"></span>
                    <span class="memory-summary-text">FORGOTTEN: ${id}</span>
                </div>
            </div>`;
        }

        return `
        <div class="learning-card" data-mem-id="${id}">
            <div class="learning-card-header">
                <span class="codicon codicon-chip"></span>
                <span>Genie Memory: ${action === 'update' ? 'Reinforced' : 'Learned'}</span>
            </div>
            <div class="learning-body">
                <div class="learning-title">${title}</div>
                <div class="learning-content">${content}</div>
                <div class="learning-meta">
                    <button class="icon-btn sync-memory-btn" 
                            data-action="${action}" 
                            data-id="${id}" 
                            data-title="${encodeURIComponent(title)}" 
                            data-content="${encodeURIComponent(content)}">
                        <i class="codicon codicon-sync"></i> Sync to Vault
                    </button>
                </div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.sync-memory-btn').forEach(btn => {
            (btn as HTMLElement).onclick = () => {
                const d = (btn as HTMLElement).dataset;
                context.vscode.postMessage({
                    command: 'applyMemoryTag',
                    params: { action: d.action, id: d.id, title: decodeURIComponent(d.title!), content: decodeURIComponent(d.content!) }
                });
            };
        });
    }
};