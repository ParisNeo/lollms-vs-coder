import { TagPlugin } from '../pluginSystem';

export const fileOpPlugin: TagPlugin = {
    id: 'file_operations',
    tagPattern: /<(move_files|copy_files|delete_files|remove_files_from_context)>([\s\S]*?)<\/\1>/gi,
    render: (match) => {
        const type = match[1];
        const inner = match[2].trim();
        const lines = inner.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        let title = "", icon = "", command = "", btnText = "";
        let detailsHtml = "";

        if (type === 'delete_files') {
            title = "Propose Deletion"; icon = "codicon-trash"; command = "deleteFile"; btnText = "Delete All";
            detailsHtml = lines.map(p => `<div class="expansion-file-item"><span class="codicon codicon-file"></span> ${p}</div>`).join('');
        } else if (type === 'move_files' || type === 'copy_files') {
            title = type === 'move_files' ? "Propose Move" : "Propose Copy";
            icon = type === 'move_files' ? "codicon-arrow-swap" : "codicon-files";
            command = type === 'move_files' ? "bulkMoveFiles" : "bulkCopyFiles";
            btnText = "Apply Changes";
            detailsHtml = lines.map(l => {
                const [src, dest] = l.split('->');
                return `<div class="file-operation-details"><span>${src}</span> <i class="codicon codicon-arrow-right"></i> <span>${dest}</span></div>`;
            }).join('');
        }

        const payload = type === 'delete_files' ? lines.join(',') : { operations: lines.map(l => ({ src: l.split('->')[0], dest: l.split('->')[1] })) };

        return `
        <div class="file-operation-block">
            <div class="file-operation-header"><span class="codicon ${icon}"></span> <span>${title}</span></div>
            <div class="expansion-body">
                <div class="expansion-file-list">${detailsHtml}</div>
                <div class="file-operation-actions">
                    <button class="code-action-btn apply-btn file-op-btn" data-command="${command}" data-payload='${JSON.stringify(payload)}'>${btnText}</button>
                </div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.file-op-btn').forEach(btn => {
            (btn as HTMLElement).onclick = () => {
                const d = (btn as HTMLElement).dataset;
                context.vscode.postMessage({ command: d.command, payload: JSON.parse(d.payload!) });
                (btn as HTMLButtonElement).disabled = true;
                btn.innerHTML = '<i class="codicon codicon-check"></i> Applied';
            };
        });
    }
};