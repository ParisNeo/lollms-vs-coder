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
                <span class="lib-status-pill" style="font-size: 10px; color: var(--vscode-charts-green); font-weight: bold;"><i class="codicon codicon-sync spin"></i> Scouting Codebase</span>
            </div>
            <div style="opacity: 0.95; line-height: 1.45; white-space: pre-wrap; font-family: var(--vscode-font-family); margin-bottom: 6px;">${escaped}</div>
            <div class="lib-live-action-tray" style="display:none; margin-top:8px; padding-top:6px; border-top:1px dashed rgba(214, 122, 13, 0.3); font-size:10.5px; opacity:0.9;">
                <div class="lib-live-action-text" style="color:var(--vscode-charts-orange); font-family:var(--vscode-editor-font-family, monospace);"></div>
            </div>
        </div>`;
    },
    initialize: (container: HTMLElement) => {
        const reportEl = container.closest('.messages')?.querySelector('.role-name');
        if (reportEl && reportEl.textContent?.includes('Librarian')) {
            container.querySelectorAll('.lib-status-pill').forEach((pill: any) => {
                pill.innerHTML = '<i class="codicon codicon-check"></i> Scout Complete';
            });
        }
    }
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

export const multiStepsTaskPlugin: TagPlugin = {
    id: 'multi_steps_task_tag',
    tagPattern: /(?:^[ \t]*|(?<=>)[ \t]*)<(?:MultiSteps_TASK|multisteps_task|multi_steps_task)\b([^>]*?)>([\s\S]*?)<\/(?:MultiSteps_TASK|multisteps_task|multi_steps_task)>/gim,
    render: (match, _context) => {
        const attrStr = match[1] || "";
        const inner = (match[2] || "").trim();

        const nbMatch = attrStr.match(/nb_steps=["']?(\d+)["']?/i);
        const nbSteps = nbMatch ? parseInt(nbMatch[1], 10) : 2;

        const stepRegex = /<step\b[^>]*number=["']?(\d+)["']?[^>]*>([\s\S]*?)<\/step>/gi;
        let sMatch: RegExpExecArray | null;
        const steps: { number: number; files: string[]; instructions: string }[] = [];

        while ((sMatch = stepRegex.exec(inner)) !== null) {
            const num = parseInt(sMatch[1], 10);
            const stepBody = sMatch[2];
            const filesMatch = stepBody.match(/<(?:target_files|edit_files)>([\s\S]*?)<\/(?:target_files|edit_files)>/i);
            const files = filesMatch ? filesMatch[1].split(/[\r\n,]+/).map(f => f.trim()).filter(Boolean) : [];
            const instMatch = stepBody.match(/<instructions>([\s\S]*?)<\/instructions>/i);
            const instructions = instMatch ? instMatch[1].trim() : stepBody.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
            steps.push({ number: num, files, instructions });
        }

        const stepsHtml = steps.length > 0 ? steps.map(s => `
            <div class="multistep-card-item" style="padding: 8px 10px; margin-top: 6px; background: rgba(0,0,0,0.18); border-radius: 6px; border: 1px solid var(--vscode-widget-border);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 4px;">
                    <span style="font-weight: bold; color: var(--vscode-charts-orange);">Step ${s.number} of ${nbSteps}</span>
                    <span style="font-size: 10px; opacity: 0.7;">${s.files.length} target file${s.files.length === 1 ? '' : 's'}</span>
                </div>
                ${s.files.length > 0 ? `<div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:4px;">${s.files.map(f => `<code style="font-size:10px; padding:1px 5px; border-radius:3px; background:rgba(255,255,255,0.06);">${f}</code>`).join(' ')}</div>` : ''}
                <div style="font-size: 11px; opacity: 0.9; line-height: 1.4;">${sanitizer.sanitize(s.instructions)}</div>
            </div>
        `).join('') : `<div style="opacity:0.9; font-size:11px; white-space:pre-wrap;">${sanitizer.sanitize(inner)}</div>`;

        return `
        <div class="multisteps-task-card" style="margin: 12px 0; padding: 12px 14px; background: rgba(214, 122, 13, 0.08); border: 1.5px solid var(--vscode-charts-orange); border-radius: 8px; font-size: 11.5px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <span style="display: flex; align-items: center; gap: 6px; font-weight: 700; color: var(--vscode-charts-orange); text-transform: uppercase; font-size: 11.5px;">
                    <i class="codicon codicon-layers"></i> Multi-Step Architecture Task (${nbSteps} Subtasks)
                </span>
                <span class="mode-badge active" style="font-size: 9.5px; padding: 2px 8px; background: var(--vscode-charts-orange); color: white;">Sequential Execution</span>
            </div>
            <div style="font-size: 11px; opacity: 0.85; margin-bottom: 6px;">
                The task exceeds single-turn context capacity. The Librarian has partitioned the implementation into sequential subtasks. Files for each step are unmuted dynamically.
            </div>
            ${stepsHtml}
        </div>`;
    },
    initialize: () => {}
};

export default librarianPlugin;