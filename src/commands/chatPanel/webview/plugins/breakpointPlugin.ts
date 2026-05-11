import { TagPlugin } from '../pluginSystem';

export const breakpointPlugin: TagPlugin = {
    id: 'set_breakpoint',
    tagPattern: /<set_breakpoint\s+([^>]*?)\s*\/>/gi,
    render: (match) => {
        const attrs: any = {};
        match[1].replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => (attrs[k] = v, ''));

        return `
        <div class="file-operation-block" style="border-left-color: var(--vscode-charts-red);">
            <div class="file-operation-header"><span class="codicon codicon-debug-breakpoint-log" style="color:var(--vscode-charts-red)"></span> <span>Proposed Breakpoint</span></div>
            <div class="expansion-body">
                <div style="font-size: 12px; margin-bottom: 8px;"><strong>${attrs.path}</strong> : Line ${attrs.line}</div>
                <div style="font-size: 11px; opacity: 0.8; font-style: italic; margin-bottom: 12px;">"${attrs.message}"</div>
                <div class="file-operation-actions">
                    <button class="code-action-btn apply-btn bp-btn" data-path="${attrs.path}" data-line="${attrs.line}">Set Breakpoint</button>
                </div>
            </div>
        </div>`;
    },
    initialize: (container, context) => {
        container.querySelectorAll('.bp-btn').forEach(btn => {
            (btn as HTMLElement).onclick = () => {
                const d = (btn as HTMLElement).dataset;
                context.vscode.postMessage({ command: 'executeLollmsCommand', details: { command: 'lollms-vs-coder.setBreakpoint', params: [d.path, parseInt(d.line!)] }});
                (btn as HTMLButtonElement).disabled = true;
                btn.textContent = 'Active';
            };
        });
    }
};